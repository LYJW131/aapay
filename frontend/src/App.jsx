import React, { useEffect, useState, useCallback } from 'react';
import Layout from './components/Layout';
import PageSettings from './components/PageSettings';
import ExpenseForm from './components/ExpenseForm';
import DailySummary from './components/DailySummary';
import DebtSettlement from './components/DebtSettlement';
import AdminPanel from './components/AdminPanel';
import SharePhraseInput from './components/SharePhraseInput';
import { NotificationProvider, useNotification } from './components/NotificationProvider';
import * as api from './services/api';

// 认证状态: 'loading' | 'admin' | 'user' | 'guest'
function AppContent() {
  const [authState, setAuthState] = useState('loading');
  const [currentSession, setCurrentSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const [users, setUsers] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [summary, setSummary] = useState({});
  const [debts, setDebts] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const { addNotification } = useNotification();

  // Global Date State (Defaults to Today)
  const [globalDate, setGlobalDate] = useState(new Date().toISOString().split('T')[0]);

  // 检查认证状态
  const checkAuthStatus = useCallback(async () => {
    try {
      // 先检查是否是管理员
      await api.checkAdminAuth();
      setIsAdmin(true);

      // 检查是否有有效的会话 cookie
      try {
        const authRes = await api.checkAuth();
        setCurrentSession({
          session_id: authRes.data.session_id,
          session_name: authRes.data.session_name
        });
        setAuthState('admin');
      } catch {
        // 管理员但还没选择会话
        setCurrentSession(null);
        setAuthState('admin');
      }
    } catch {
      // 不是管理员，检查普通用户认证
      try {
        const authRes = await api.checkAuth();
        setCurrentSession({
          session_id: authRes.data.session_id,
          session_name: authRes.data.session_name
        });
        setIsAdmin(false);
        setAuthState('user');
      } catch {
        // 未认证
        setIsAdmin(false);
        setCurrentSession(null);
        setAuthState('guest');
      }
    }
  }, []);

  // 获取业务数据
  const fetchData = useCallback(async () => {
    if (!currentSession) return;

    try {
      const [uRes, eRes, sRes, dRes] = await Promise.all([
        api.getUsers(),
        api.getExpenses(),
        api.getSummary(),
        api.getDebts()
      ]);
      setUsers(uRes.data);
      setExpenses(eRes.data);
      setSummary(sRes.data);
      setDebts(dRes.data);
    } catch (error) {
      console.error("Failed to fetch data", error);
      // 如果 401 则重新检查认证
      if (error.response?.status === 401) {
        checkAuthStatus();
      }
    }
  }, [currentSession, checkAuthStatus]);

  // 初始化认证检查
  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  // 当会话改变时获取数据
  useEffect(() => {
    if (currentSession) {
      fetchData();
      setConnectionStatus('connecting');

      // 订阅 SSE
      const closeSSE = api.subscribeToEvents(
        (data) => {
          console.log("SSE Event:", data);

          // 处理会话删除事件
          if (data.type === 'SESSION_DELETED') {
            addNotification('当前会话已被删除', 'session_deleted');
            setCurrentSession(null);
            checkAuthStatus();
            return;
          }

          fetchData();

          // 显示通知
          if (data.message && data.type !== 'heartbeat') {
            addNotification(data.message, data.action || 'info');
          }
        },
        (error) => {
          console.error("SSE Error:", error);
          setConnectionStatus('error');
        }
      );

      setConnectionStatus('connected');

      return () => closeSSE();
    }
  }, [currentSession, fetchData, addNotification, checkAuthStatus]);

  // 处理会话切换
  const handleSessionChange = (session) => {
    setCurrentSession(session);
    if (session) {
      // 重新获取数据
      fetchData();
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

  // 加载状态
  if (authState === 'loading') {
    return (
      <Layout status="connecting" sessionName={null}>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent"></div>
        </div>
      </Layout>
    );
  }

  // 访客状态：只显示分享短语输入
  if (authState === 'guest') {
    return (
      <Layout status="disconnected" sessionName={null}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <SharePhraseInput onSuccess={handlePhraseSuccess} />
        </div>
      </Layout>
    );
  }

  // 管理员或普通用户
  const hasValidSession = !!currentSession;
  const isDisabled = isAdmin && !hasValidSession;

  return (
    <Layout status={connectionStatus} sessionName={currentSession?.session_name}>
      {/* 管理员面板 */}
      {isAdmin && (
        <div className="col-span-full mb-6">
          <AdminPanel
            currentSession={currentSession}
            onSessionChange={handleSessionChange}
            onLogout={handleLogout}
          />
        </div>
      )}

      {/* 未选择会话时的提示 */}
      {isDisabled && (
        <div className="col-span-full">
          <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-6 py-4 rounded-xl text-center">
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
      </div>
      <div className={`space-y-6 ${isDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <DebtSettlement debts={debts} />
        <DailySummary
          expenses={expenses}
          users={users}
          summary={summary}
          selectedDate={globalDate}
        />

        {/* 普通用户可以切换会话 */}
        {!isAdmin && hasValidSession && (
          <SharePhraseInput isCompact onSuccess={handlePhraseSuccess} />
        )}
      </div>
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

