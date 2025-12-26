import React, { useState, useEffect } from 'react';
import { Shield, Plus, Trash2, Key, Clock, RefreshCw, LogOut, X, FolderOpen, ChevronDown, QrCode, Copy, Check } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import * as api from '../services/api';
import { useNotification } from './NotificationProvider';

const AdminPanel = ({ currentSession, onSessionChange, onLogout, isCollapsed, onCollapseChange, sessions, setSessions, phrases, setPhrases }) => {
    const { addNotification } = useNotification();

    // 跟踪是否已经首次渲染，用于控制动画
    const hasRendered = React.useRef(false);
    useEffect(() => {
        hasRendered.current = true;
    }, []);

    // 保存折叠状态到 localStorage
    useEffect(() => {
        localStorage.setItem('adminPanelCollapsed', isCollapsed);
    }, [isCollapsed]);

    // 使用 ref 保持最新的引用，避免 SSE 重连
    const currentSessionRef = React.useRef(currentSession);
    const setSessionsRef = React.useRef(setSessions);
    const setPhrasesRef = React.useRef(setPhrases);
    const onSessionChangeRef = React.useRef(onSessionChange);
    const addNotificationRef = React.useRef(addNotification);

    useEffect(() => {
        currentSessionRef.current = currentSession;
        setSessionsRef.current = setSessions;
        setPhrasesRef.current = setPhrases;
        onSessionChangeRef.current = onSessionChange;
        addNotificationRef.current = addNotification;
    });

    // 订阅管理员事件流以实现跨设备同步
    useEffect(() => {
        const unsubscribe = api.subscribeToAdminEvents(
            (event) => {
                console.log('Admin event received:', event);
                const session = currentSessionRef.current;
                switch (event.type) {
                    case 'SESSION_CREATED':
                        // 直接从事件数据更新，而非重新请求
                        if (event.data?.session) {
                            setSessionsRef.current(prev => [event.data.session, ...prev]);
                        }
                        addNotificationRef.current(`会话 "${event.data?.session?.name}" 已创建`, 'add');
                        break;
                    case 'SESSION_DELETED':
                        // 直接过滤删除的会话
                        if (event.data?.session_id) {
                            setSessionsRef.current(prev =>
                                prev.filter(s => s.id !== event.data.session_id)
                            );
                        }
                        addNotificationRef.current('会话已被删除', 'delete');
                        // 如果删除的是当前会话，清除状态
                        if (session?.session_id === event.data?.session_id) {
                            onSessionChangeRef.current(null);
                        }
                        break;
                    case 'PHRASE_CREATED':
                        // 直接从事件数据更新短语列表
                        if (session?.session_id === event.data?.session_id && event.data?.phrase) {
                            setPhrasesRef.current(prev => [event.data.phrase, ...prev]);
                        }
                        addNotificationRef.current(`分享短语 "${event.data?.phrase?.phrase}" 已创建`, 'add');
                        break;
                    case 'PHRASE_DELETED':
                        // 直接过滤删除的短语
                        if (session?.session_id === event.data?.session_id && event.data?.phrase_id) {
                            setPhrasesRef.current(prev =>
                                prev.filter(p => p.id !== event.data.phrase_id)
                            );
                        }
                        addNotificationRef.current('分享短语已删除', 'delete');
                        break;
                    default:
                        break;
                }
            },
            (error) => {
                console.error('Admin SSE error:', error);
            },
            () => {
                console.log('Admin SSE connected');
            }
        );

        return () => unsubscribe();
    }, []); // 空依赖数组，只在组件挂载时订阅一次

    const [newSessionName, setNewSessionName] = useState('');
    const [showPhraseForm, setShowPhraseForm] = useState(false);
    const [newPhrase, setNewPhrase] = useState('');
    const [phraseValidFrom, setPhraseValidFrom] = useState('');
    const [phraseValidUntil, setPhraseValidUntil] = useState('');
    const [loading, setLoading] = useState(false);
    const [qrModalPhrase, setQrModalPhrase] = useState(null); // 当前显示二维码的短语
    const [linkCopied, setLinkCopied] = useState(false); // 链接复制成功状态

    // 刷新会话列表（供创建/删除后使用）
    const loadSessions = async () => {
        try {
            const res = await api.getSessions();
            setSessions(res.data);
        } catch (err) {
            console.error('Failed to load sessions', err);
        }
    };

    // 刷新当前会话的分享短语（供创建/删除后使用）
    const loadPhrases = async () => {
        if (!currentSession) return;
        try {
            const res = await api.getPhrases(currentSession.session_id);
            setPhrases(res.data);
        } catch (err) {
            console.error('Failed to load phrases', err);
        }
    };

    // 创建会话
    const handleCreateSession = async (e) => {
        e.preventDefault();
        if (!newSessionName.trim()) {
            addNotification('请输入会话名称', 'error');
            return;
        }
        setLoading(true);
        try {
            await api.createSession(newSessionName);
            // 通知由 SSE 事件统一处理
            setNewSessionName('');
        } catch (err) {
            addNotification(err.response?.data?.detail || '创建失败', 'error');
        } finally {
            setLoading(false);
        }
    };

    // 删除会话
    const handleDeleteSession = async (id, name) => {
        if (!window.confirm(`确定要删除会话 "${name}" 吗？所有相关数据将被永久删除。`)) {
            return;
        }
        setLoading(true);
        try {
            await api.deleteSession(id);
            // 通知和状态更新由 SSE 事件统一处理
        } catch (err) {
            addNotification(err.response?.data?.detail || '删除失败', 'error');
        } finally {
            setLoading(false);
        }
    };

    // 切换会话
    const handleSwitchSession = async (session) => {
        setLoading(true);
        try {
            const res = await api.switchSession(session.id);
            // 保存返回的 token
            if (res.data.token) {
                api.setToken(res.data.token);
            }
            addNotification(`已切换到 "${session.name}"`, 'update');
            // 传递完整数据给父组件，避免额外请求
            onSessionChange({
                session_id: session.id,
                session_name: res.data.session_name || session.name,
                users: res.data.users,
                expenses: res.data.expenses,
                summary: res.data.summary,
                sessions: res.data.sessions,
                phrases: res.data.phrases
            });
        } catch (err) {
            addNotification(err.response?.data?.detail || '切换失败', 'error');
        } finally {
            setLoading(false);
        }
    };

    // 创建分享短语
    const handleCreatePhrase = async (e) => {
        e.preventDefault();
        const trimmedPhrase = newPhrase.trim();
        if (!trimmedPhrase || !phraseValidFrom || !phraseValidUntil) return;
        // 验证是否只包含大小写字母和数字
        if (!/^[a-zA-Z0-9]+$/.test(trimmedPhrase)) {
            addNotification('分享短语只能包含大小写字母和数字', 'error');
            return;
        }
        if (trimmedPhrase.length < 3) {
            addNotification('分享短语至少需要3位', 'error');
            return;
        }
        setLoading(true);
        try {
            await api.createPhrase(currentSession.session_id, {
                phrase: newPhrase,
                valid_from: new Date(phraseValidFrom).toISOString(),
                valid_until: new Date(phraseValidUntil).toISOString()
            });
            // 通知由 SSE 事件统一处理
            setNewPhrase('');
            setPhraseValidFrom('');
            setPhraseValidUntil('');
            setShowPhraseForm(false);
        } catch (err) {
            addNotification(err.response?.data?.detail || '创建失败', 'error');
        } finally {
            setLoading(false);
        }
    };

    // 删除分享短语
    const handleDeletePhrase = async (id) => {
        try {
            await api.deletePhrase(id);
            // 通知由 SSE 事件统一处理
        } catch (err) {
            addNotification(err.response?.data?.detail || '删除失败', 'error');
        }
    };

    // 格式化时间显示
    const formatDateTime = (isoString) => {
        const date = new Date(isoString);
        const month = date.getMonth() + 1;
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${month}月${day}日  ${hours}:${minutes}`;
    };

    // 检查短语是否有效
    const isPhraseActive = (phrase) => {
        const now = new Date();
        const from = new Date(phrase.valid_from);
        const until = new Date(phrase.valid_until);
        return now >= from && now < until;
    };

    // 生成分享链接
    const getShareUrl = (phrase) => {
        const baseUrl = window.location.origin + window.location.pathname;
        return `${baseUrl}#p=${encodeURIComponent(phrase)}`;
    };

    // 复制链接到剪贴板
    const handleCopyLink = async (phrase) => {
        const url = getShareUrl(phrase);
        try {
            await navigator.clipboard.writeText(url);
            setLinkCopied(true);
            addNotification('链接已复制到剪贴板', 'success');
            setTimeout(() => setLinkCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy link', err);
            addNotification('复制失败', 'error');
        }
    };

    return (
        <div className="bg-gradient-to-r from-purple-50 to-indigo-50 dark:from-purple-900/30 dark:to-indigo-900/30 rounded-xl shadow-sm border border-purple-100 dark:border-purple-800 overflow-hidden">
            {/* 可点击的标题栏 */}
            <div
                className="flex items-center justify-between p-6 cursor-pointer hover:bg-purple-100/50 dark:hover:bg-purple-800/30 transition-colors"
                onClick={() => onCollapseChange(!isCollapsed)}
            >
                <h2 className="text-xl font-bold text-purple-800 dark:text-purple-200 flex items-center gap-2">
                    <Shield size={20} className="text-purple-600 dark:text-purple-400" />
                    管理员面板
                    {currentSession && (
                        <span className="text-sm font-normal text-purple-500 dark:text-purple-400">
                            · {currentSession.session_name || currentSession.session_id}
                        </span>
                    )}
                    <motion.div
                        initial={false}
                        animate={{ rotate: isCollapsed ? -90 : 0 }}
                        transition={{ duration: 0.2 }}
                    >
                        <ChevronDown size={18} className="text-purple-400 dark:text-purple-500" />
                    </motion.div>
                </h2>
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        // 清除 token 后直接跳转
                        localStorage.removeItem('aapay_token');
                        window.location.href = '/oauth2/sign_out?rd=%2F';
                    }}
                    className="text-sm text-red-500 hover:text-red-600 flex items-center gap-1 px-3 py-1.5 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                >
                    <LogOut size={14} /> 登出
                </button>
            </div>

            {/* 可折叠的内容区域 */}
            <AnimatePresence initial={false}>
                {!isCollapsed && (
                    <motion.div
                        key="content"
                        initial={hasRendered.current ? { height: 0, opacity: 0 } : false}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: 'easeInOut' }}
                        className="overflow-hidden"
                    >
                        <div className="px-6 pb-4">
                            {/* 会话选择 */}
                            <div className={currentSession ? 'mb-6' : ''}>
                                <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                    <FolderOpen size={14} className="inline mr-1" />
                                    会话管理
                                </label>

                                {/* 创建新会话 */}
                                <form onSubmit={handleCreateSession} className="flex gap-2 pb-2">
                                    <input
                                        type="text"
                                        value={newSessionName}
                                        onChange={(e) => setNewSessionName(e.target.value)}
                                        placeholder="新会话名称"
                                        className="flex-1 h-10 px-3 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 dark:text-gray-100 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-300"
                                        maxLength={10}
                                    />
                                    <button
                                        type="submit"
                                        disabled={loading}
                                        className="h-10 w-10 flex items-center justify-center rounded-lg border border-purple-600 bg-purple-600 text-white hover:bg-purple-700 hover:border-purple-700 disabled:opacity-50 transition-all"
                                    >
                                        <Plus size={18} />
                                    </button>
                                </form>

                                {/* 会话列表 */}
                                <div>
                                    <AnimatePresence initial={false}>
                                        {sessions.map(session => (
                                            <motion.div
                                                key={session.id}
                                                initial={{ opacity: 0, height: 0 }}
                                                animate={{ opacity: 1, height: 'auto' }}
                                                exit={{ opacity: 0, height: 0 }}
                                                transition={{ duration: 0.2 }}
                                                style={{ overflow: 'hidden' }}
                                            >
                                                <div className="flex gap-2 pb-2">
                                                    <button
                                                        onClick={() => handleSwitchSession(session)}
                                                        className={`flex-1 h-10 px-3 rounded-lg border text-left font-medium transition-all ${currentSession?.session_id === session.id
                                                            ? 'bg-purple-100 dark:bg-purple-900/50 border-purple-300 dark:border-purple-700 text-purple-700 dark:text-purple-300'
                                                            : 'bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-purple-200'
                                                            }`}
                                                    >
                                                        {session.name}
                                                        {currentSession?.session_id === session.id && (
                                                            <span className="ml-2 text-xs text-purple-600 dark:text-purple-400">(当前)</span>
                                                        )}
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteSession(session.id, session.name)}
                                                        className="h-10 w-10 flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-400 hover:text-red-500 hover:border-red-200 transition-all"
                                                    >
                                                        <Trash2 size={18} />
                                                    </button>
                                                </div>
                                            </motion.div>
                                        ))}
                                    </AnimatePresence>
                                </div>
                            </div>

                            {/* 分享短语管理（仅当选中会话时显示） */}
                            {currentSession && (
                                <div>
                                    <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">
                                        <Key size={14} className="inline mr-1" />
                                        分享短语
                                    </label>

                                    {/* 新增分享短语表单 */}
                                    <form onSubmit={handleCreatePhrase} className="pb-2">
                                        <div className="flex gap-2">
                                            <input
                                                type="text"
                                                value={newPhrase}
                                                onChange={(e) => {
                                                    const value = e.target.value;
                                                    setNewPhrase(value);
                                                    // 输入时自动设置默认时间
                                                    if (value && !phraseValidFrom) {
                                                        const now = new Date();
                                                        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                                                        const formatForInput = (date) => {
                                                            const year = date.getFullYear();
                                                            const month = String(date.getMonth() + 1).padStart(2, '0');
                                                            const day = String(date.getDate()).padStart(2, '0');
                                                            const hours = String(date.getHours()).padStart(2, '0');
                                                            const minutes = String(date.getMinutes()).padStart(2, '0');
                                                            return `${year}-${month}-${day}T${hours}:${minutes}`;
                                                        };
                                                        setPhraseValidFrom(formatForInput(now));
                                                        setPhraseValidUntil(formatForInput(tomorrow));
                                                    }
                                                }}
                                                placeholder="新分享短语 (3-16位字母数字)"
                                                className="flex-1 h-10 px-3 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 dark:text-gray-100 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-300"
                                                minLength={3}
                                                maxLength={16}
                                            />
                                            <button
                                                type="submit"
                                                disabled={loading || newPhrase.length < 3}
                                                className="h-10 w-10 flex items-center justify-center rounded-lg border border-purple-600 bg-purple-600 text-white hover:bg-purple-700 hover:border-purple-700 disabled:opacity-50 transition-all"
                                            >
                                                <Plus size={18} />
                                            </button>
                                        </div>

                                        {/* 输入后展开日期选择器 */}
                                        <AnimatePresence initial={false}>
                                            {newPhrase.length > 0 && (
                                                <motion.div
                                                    initial={{ height: 0, opacity: 0 }}
                                                    animate={{ height: 'auto', opacity: 1 }}
                                                    exit={{ height: 0, opacity: 0 }}
                                                    transition={{ duration: 0.2 }}
                                                    style={{ overflow: 'hidden' }}
                                                >
                                                    <div className="flex flex-col sm:flex-row gap-2 mt-2">
                                                        <div className="flex-1">
                                                            <label className="text-xs text-gray-500 dark:text-gray-400">开始时间</label>
                                                            <input
                                                                type="datetime-local"
                                                                value={phraseValidFrom}
                                                                onChange={(e) => setPhraseValidFrom(e.target.value)}
                                                                className="w-full h-10 px-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm bg-gray-100 dark:bg-gray-700 dark:text-gray-100 appearance-none"
                                                            />
                                                        </div>
                                                        <div className="flex-1">
                                                            <label className="text-xs text-gray-500 dark:text-gray-400">结束时间</label>
                                                            <input
                                                                type="datetime-local"
                                                                value={phraseValidUntil}
                                                                onChange={(e) => setPhraseValidUntil(e.target.value)}
                                                                className="w-full h-10 px-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm bg-gray-100 dark:bg-gray-700 dark:text-gray-100 appearance-none"
                                                            />
                                                        </div>
                                                    </div>
                                                </motion.div>
                                            )}
                                        </AnimatePresence>
                                    </form>

                                    {/* 分享短语列表 */}
                                    <div>
                                        <AnimatePresence initial={false}>
                                            {phrases.map(phrase => (
                                                <motion.div
                                                    key={phrase.id}
                                                    initial={{ opacity: 0, height: 0 }}
                                                    animate={{ opacity: 1, height: 'auto' }}
                                                    exit={{ opacity: 0, height: 0 }}
                                                    transition={{ duration: 0.2 }}
                                                    style={{ overflow: 'hidden' }}
                                                >
                                                    <div className="flex gap-2 pb-2">
                                                        <div
                                                            className={`flex-1 min-h-[40px] px-3 py-2 rounded-lg border flex flex-col sm:flex-row sm:items-center justify-between gap-1 ${isPhraseActive(phrase)
                                                                ? 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800'
                                                                : 'bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-600 opacity-60'
                                                                }`}
                                                        >
                                                            <span className="font-mono font-bold text-gray-700 dark:text-gray-200 text-sm">{phrase.phrase}</span>
                                                            <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center font-mono flex-shrink-0">
                                                                <Clock size={12} className="mr-1 flex-shrink-0" />
                                                                <span>{formatDateTime(phrase.valid_from)}</span>
                                                                <span className="mx-1">~</span>
                                                                <span>{formatDateTime(phrase.valid_until)}</span>
                                                            </span>
                                                        </div>
                                                        <button
                                                            onClick={() => setQrModalPhrase(phrase)}
                                                            className="self-stretch w-10 flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-400 hover:text-purple-500 hover:border-purple-200 transition-all"
                                                            title="显示二维码"
                                                        >
                                                            <QrCode size={18} />
                                                        </button>
                                                        <button
                                                            onClick={() => handleDeletePhrase(phrase.id)}
                                                            className="self-stretch w-10 flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-400 hover:text-red-500 hover:border-red-200 transition-all"
                                                        >
                                                            <Trash2 size={18} />
                                                        </button>
                                                    </div>
                                                </motion.div>
                                            ))}
                                        </AnimatePresence>
                                    </div>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* 二维码模态框 */}
            <AnimatePresence>
                {qrModalPhrase && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
                        onClick={() => setQrModalPhrase(null)}
                    >
                        <motion.div
                            initial={{ scale: 0.9, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.9, opacity: 0 }}
                            transition={{ type: 'spring', duration: 0.3 }}
                            className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-6 max-w-sm w-full"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* 模态框头部 */}
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
                                    <QrCode size={20} className="text-purple-500" />
                                    分享二维码
                                </h3>
                                <button
                                    onClick={() => setQrModalPhrase(null)}
                                    className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                                >
                                    <X size={20} />
                                </button>
                            </div>

                            {/* 短语信息 */}
                            <div className={`mb-4 px-3 py-2 rounded-lg border ${isPhraseActive(qrModalPhrase)
                                ? 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800'
                                : 'bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-600'
                                }`}>
                                <p className="font-mono font-bold text-center text-gray-700 dark:text-gray-200">
                                    {qrModalPhrase.phrase}
                                </p>
                                <p className="text-xs text-gray-500 dark:text-gray-400 text-center mt-1 flex items-center justify-center gap-1">
                                    <Clock size={12} />
                                    {formatDateTime(qrModalPhrase.valid_from)} ~ {formatDateTime(qrModalPhrase.valid_until)}
                                </p>
                            </div>

                            {/* 二维码 */}
                            <div className="flex justify-center mb-4 p-4 bg-white rounded-xl">
                                <QRCodeSVG
                                    value={getShareUrl(qrModalPhrase.phrase)}
                                    size={200}
                                    level="M"
                                    includeMargin={true}
                                    bgColor="#ffffff"
                                    fgColor="#1f2937"
                                />
                            </div>

                            {/* 链接显示和复制 */}
                            <div className="flex gap-2">
                                <div className="flex-1 px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg overflow-hidden">
                                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate font-mono">
                                        {getShareUrl(qrModalPhrase.phrase)}
                                    </p>
                                </div>
                                <button
                                    onClick={() => handleCopyLink(qrModalPhrase.phrase)}
                                    className={`px-3 py-2 rounded-lg border transition-all flex items-center gap-1 ${linkCopied
                                            ? 'bg-green-100 dark:bg-green-900/50 border-green-300 dark:border-green-700 text-green-600 dark:text-green-400'
                                            : 'bg-purple-100 dark:bg-purple-900/50 border-purple-300 dark:border-purple-700 text-purple-600 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-800/50'
                                        }`}
                                >
                                    {linkCopied ? <Check size={16} /> : <Copy size={16} />}
                                    <span className="text-sm font-medium">{linkCopied ? '已复制' : '复制'}</span>
                                </button>
                            </div>

                            {/* 提示 */}
                            <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-4">
                                扫描二维码或分享链接，其他人可直接加入此会话
                            </p>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default AdminPanel;

