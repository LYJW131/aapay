import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Layout from './components/Layout';
import PageSettings from './components/PageSettings';
import ExpenseForm from './components/ExpenseForm';
import DailySummary from './components/DailySummary';
import DebtSettlement from './components/DebtSettlement';
import AdminPanel from './components/AdminPanel';
import SharePhraseInput from './components/SharePhraseInput';
import { NotificationProvider, useNotification } from './components/NotificationProvider';
import { calculateDebts } from './utils/debtCalculator';
import * as api from './services/api';

// 认证状态: 'loading' | 'admin' | 'user' | 'guest'
function AppContent() {
  const [authState, setAuthState] = useState('loading');
  const [currentSession, setCurrentSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSharedMode, setIsSharedMode] = useState(false);

  // 管理员面板折叠状态（提前从 localStorage 读取）
  const [adminPanelCollapsed, setAdminPanelCollapsed] = useState(() => {
    const saved = localStorage.getItem('adminPanelCollapsed');
    return saved === 'true';
  });

  const [users, setUsers] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [summary, setSummary] = useState({});
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [dataLoaded, setDataLoaded] = useState(false);

  // 管理员相关数据
  const [sessions, setSessions] = useState([]);
  const [phrases, setPhrases] = useState([]);

  const { addNotification } = useNotification();

  // Global Date State (Defaults to Today)
  const [globalDate, setGlobalDate] = useState(new Date().toISOString().split('T')[0]);

  // 前端计算当前日期的转账结算
  const debts = useMemo(() => {
    const filteredExpenses = expenses.filter(e => e.date === globalDate);
    return calculateDebts(filteredExpenses, users);
  }, [expenses, users, globalDate]);

  // 获取业务数据（内部使用，返回 Promise）
  const loadData = async (sessionId, loadAdmin = false) => {
    try {
      // 基础数据（debts 由前端 useMemo 计算）
      const [uRes, eRes, sRes] = await Promise.all([
        api.getUsers(),
        api.getExpenses(),
        api.getSummary()
      ]);
      setUsers(uRes.data);
      setExpenses(eRes.data);
      setSummary(sRes.data);

      // 管理员数据
      if (loadAdmin) {
        try {
          const [sessionsRes, phrasesRes] = await Promise.all([
            api.getSessions(),
            sessionId ? api.getPhrases(sessionId) : Promise.resolve({ data: [] })
          ]);
          setSessions(sessionsRes.data);
          setPhrases(phrasesRes.data);
        } catch (err) {
          console.error('Failed to load admin data', err);
        }
      }

      setDataLoaded(true);
    } catch (error) {
      console.error("Failed to fetch data", error);
      throw error;
    }
  };

  // 检查认证状态（整合数据获取）
  const checkAuthStatus = useCallback(async () => {
    try {
      // 先检查是否是管理员
      await api.checkAdminAuth();
      setIsAdmin(true);
      setIsSharedMode(false);

      // 检查是否有有效的会话
      try {
        const authRes = await api.checkAuth();
        const session = {
          session_id: authRes.data.session_id,
          session_name: authRes.data.session_name
        };
        setCurrentSession(session);

        // 获取数据后再设置认证状态
        await loadData(session.session_id, true);
        setAuthState('admin');
      } catch {
        // 管理员但还没选择会话，只加载 sessions 列表
        setCurrentSession(null);
        try {
          const sessionsRes = await api.getSessions();
          setSessions(sessionsRes.data);
        } catch (err) {
          console.error('Failed to load sessions', err);
        }
        setAuthState('admin');
      }
    } catch {
      // 不是管理员，检查普通用户认证
      try {
        const authRes = await api.checkAuth();
        const session = {
          session_id: authRes.data.session_id,
          session_name: authRes.data.session_name
        };
        setCurrentSession(session);
        setIsAdmin(false);

        // 检查是否是共享模式
        if (authRes.data.role === 'shared') {
          setIsSharedMode(true);
        } else {
          setIsSharedMode(false);
        }

        // 获取数据后再设置认证状态
        await loadData(null, false);
        setAuthState('user');
      } catch {
        // 未认证
        setIsAdmin(false);
        setIsSharedMode(false);
        setCurrentSession(null);
        setAuthState('guest');
      }
    }
  }, []);

  // 获取业务数据（供 SSE 事件刷新使用）
  const fetchData = useCallback(async () => {
    if (!currentSession) return;
    try {
      await loadData();
    } catch (error) {
      if (error.response?.status === 401) {
        checkAuthStatus();
      }
    }
  }, [currentSession, checkAuthStatus]);

  // 处理URL哈希参数中的分享短语
  const handleHashPhrase = useCallback(async () => {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith('#p=')) return false;

    const phrase = decodeURIComponent(hash.substring(3));
    if (!phrase || phrase.length < 6) return false;

    // 清除 URL 中的哈希参数
    window.history.replaceState(null, '', window.location.pathname + window.location.search);

    try {
      // 先删除本地的旧 JWT，再交换新的
      api.removeToken();
      const res = await api.exchangePhrase(phrase);
      const newToken = res.data.token;
      if (newToken) {
        api.setToken(newToken);
      }
      addNotification('登录成功', 'success');
      return true;
    } catch (err) {
      const errorMsg = err.response?.data?.detail || '分享短语无效或已过期';
      addNotification(errorMsg, 'error');
      return false;
    }
  }, [addNotification]);

  // 初始化认证检查
  useEffect(() => {
    const init = async () => {
      // 先尝试处理URL中的分享短语
      await handleHashPhrase();
      // 然后进行认证检查
      checkAuthStatus();
    };
    init();
  }, [checkAuthStatus, handleHashPhrase]);

  // 当会话改变时订阅 SSE
  useEffect(() => {
    // 认证加载中不处理
    if (authState === 'loading') return;

    if (currentSession && dataLoaded) {
      setConnectionStatus('connecting');

      let isCancelled = false;

      // 订阅 SSE
      const closeSSE = api.subscribeToEvents(
        (data) => {
          if (isCancelled) return;
          console.log("SSE Event:", data);

          // 收到任何事件都表示连接成功
          setConnectionStatus('connected');

          // 心跳事件不需要其他处理
          if (data.type === 'heartbeat') {
            return;
          }

          // 处理会话删除事件
          if (data.type === 'SESSION_DELETED') {
            addNotification('当前会话已被删除', 'session_deleted');
            setCurrentSession(null);
            checkAuthStatus();
            return;
          }

          // 根据事件类型增量更新状态
          if (data.type === 'USER_UPDATE' && data.data) {
            switch (data.action) {
              case 'user_add':
                setUsers(prev => [...prev, data.data.user]);
                break;
              case 'user_delete':
                setUsers(prev => prev.filter(u => u.id !== data.data.user_id));
                break;
              case 'user_update':
                setUsers(prev => prev.map(u =>
                  u.id === data.data.user.id ? data.data.user : u
                ));
                break;
            }
            // 用户操作只更新 summary（debts 需要用户刷新日期后重新获取）
            if (data.data.summary) setSummary(data.data.summary);
          } else if (data.type === 'EXPENSE_UPDATE' && data.data) {
            switch (data.action) {
              case 'expense_add':
                setExpenses(prev => [...prev, data.data.expense]);
                break;
              case 'expense_delete':
                setExpenses(prev => prev.filter(e => e.id !== data.data.expense_id));
                break;
            }
            // 直接从事件中获取 summary（debts 由前端自动计算）
            if (data.data.summary) setSummary(data.data.summary);
          }

          // 显示通知
          if (data.message) {
            addNotification(data.message, data.action || 'info');
          }
        },
        (error) => {
          if (isCancelled) return;
          console.error("SSE Error:", error);
          setConnectionStatus('disconnected');
        },
        () => {
          if (isCancelled) return;
          // 连接成功回调
          setConnectionStatus('connected');
        }
      );

      return () => {
        isCancelled = true;
        closeSSE();
      };
    } else if (!currentSession) {
      // 没有会话时显示为未连接
      setConnectionStatus('disconnected');
    }
    // 有会话但数据未加载时保持 connecting 状态
  }, [authState, currentSession, dataLoaded, isAdmin]);

  // 处理会话切换
  const handleSessionChange = async (session) => {
    setDataLoaded(false); // 重置加载状态

    if (session) {
      // 切换响应中包含完整数据，直接使用
      if (session.users && session.expenses && session.summary) {
        setCurrentSession({
          session_id: session.session_id,
          session_name: session.session_name
        });
        setUsers(session.users);
        setExpenses(session.expenses);
        setSummary(session.summary);
        if (session.sessions) setSessions(session.sessions);
        if (session.phrases) setPhrases(session.phrases);
        setDataLoaded(true);
      } else {
        // 兼容旧逻辑：没有数据时重新获取
        setCurrentSession(session);
        try {
          await loadData(session.session_id, isAdmin);
        } catch (error) {
          console.error('Failed to load data after session change', error);
        }
      }
    } else {
      setCurrentSession(null);
    }
  };

  // 处理登出
  const handleLogout = async () => {
    try {
      await api.logout();
    } catch (err) {
      console.error('Logout error', err);
    }
    setCurrentSession(null);
    setIsAdmin(false);
    setAuthState('guest');
  };

  // 处理分享短语成功
  const handlePhraseSuccess = (data) => {
    setCurrentSession({ session_id: data.session_id, session_name: '' });
    checkAuthStatus();
  };

  // 管理员或普通用户
  const hasValidSession = !!currentSession;
  const isDisabled = isAdmin && !hasValidSession;

  // 初始加载状态（仅认证检查中）
  if (authState === 'loading') {
    return (
      <Layout status="connecting" sessionName={null}>
        <div className="col-span-full flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent"></div>
        </div>
      </Layout>
    );
  }

  // 访客状态：只显示分享短语输入
  if (authState === 'guest') {
    return (
      <Layout status="disconnected" sessionName={null}>
        <div className="col-span-full flex items-center justify-center min-h-[60vh]">
          <SharePhraseInput onSuccess={handlePhraseSuccess} />
        </div>
      </Layout>
    );
  }

  return (
    <Layout status={connectionStatus} sessionName={currentSession?.session_name}>
      {/* 管理员面板 */}
      {isAdmin && (
        <div className="col-span-full">
          <AdminPanel
            currentSession={currentSession}
            onSessionChange={handleSessionChange}
            onLogout={handleLogout}
            isCollapsed={adminPanelCollapsed}
            onCollapseChange={setAdminPanelCollapsed}
            sessions={sessions}
            setSessions={setSessions}
            phrases={phrases}
            setPhrases={setPhrases}
          />
        </div>
      )}

      {/* 未选择会话时的提示 */}
      {isDisabled && (
        <div className="col-span-full">
          <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-6 py-4 rounded-apple text-center">
            <p className="text-lg font-medium">请先选择一个会话</p>
            <p className="text-sm text-yellow-600 mt-1">在上方管理员面板中选择或创建一个会话以继续</p>
          </div>
        </div>
      )}

      {/* 主要内容区域 */}
      <div className={`space-y-6 ${isDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <PageSettings
          users={users}
          globalDate={globalDate}
          setGlobalDate={setGlobalDate}
        />
        <ExpenseForm
          users={users}
          defaultDate={globalDate}
        />

        {/* 普通用户可以切换会话 - PC 端在左栏底部（共享模式下隐藏） */}
        {!isAdmin && hasValidSession && !isSharedMode && (
          <div className="hidden md:block">
            <SharePhraseInput isCompact onSuccess={handlePhraseSuccess} onLogout={handleLogout} />
          </div>
        )}
      </div>
      <div className={`space-y-6 ${isDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <DebtSettlement debts={debts} />
        <DailySummary
          expenses={expenses}
          users={users}
          summary={summary}
          selectedDate={globalDate}
        />
      </div>

      {/* 普通用户可以切换会话 - 移动端在最底部（共享模式下隐藏） */}
      {!isAdmin && hasValidSession && !isSharedMode && (
        <div className="col-span-full md:hidden">
          <SharePhraseInput isCompact onSuccess={handlePhraseSuccess} onLogout={handleLogout} />
        </div>
      )}
    </Layout>
  );
}

function App() {
  return (
    <NotificationProvider>
      <AppContent />
    </NotificationProvider>
  );
}

export default App;

