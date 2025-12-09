import React, { useState, useEffect } from 'react';
import { Shield, Plus, Trash2, Key, Clock, RefreshCw, LogOut, X, FolderOpen, ChevronDown } from 'lucide-react';
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

    const [newSessionName, setNewSessionName] = useState('');
    const [showPhraseForm, setShowPhraseForm] = useState(false);
    const [newPhrase, setNewPhrase] = useState('');
    const [phraseValidFrom, setPhraseValidFrom] = useState('');
    const [phraseValidUntil, setPhraseValidUntil] = useState('');
    const [loading, setLoading] = useState(false);

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
            addNotification(`会话 "${newSessionName}" 创建成功`, 'add');
            setNewSessionName('');
            loadSessions();
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
            addNotification('会话已删除', 'delete');
            loadSessions();
            // 如果删除的是当前会话，清除状态
            if (currentSession?.session_id === id) {
                onSessionChange(null);
            }
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
            onSessionChange({ session_id: session.id, session_name: session.name });
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
            addNotification(`分享短语 "${newPhrase}" 创建成功`, 'add');
            setNewPhrase('');
            setPhraseValidFrom('');
            setPhraseValidUntil('');
            setShowPhraseForm(false);
            loadPhrases();
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
            addNotification('分享短语已删除', 'delete');
            loadPhrases();
        } catch (err) {
            addNotification(err.response?.data?.detail || '删除失败', 'error');
        }
    };

    // 格式化时间显示
    const formatDateTime = (isoString) => {
        const date = new Date(isoString);
        return date.toLocaleString('zh-CN', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    // 检查短语是否有效
    const isPhraseActive = (phrase) => {
        const now = new Date();
        const from = new Date(phrase.valid_from);
        const until = new Date(phrase.valid_until);
        return now >= from && now < until;
    };

    return (
        <div className="bg-gradient-to-r from-purple-50 to-indigo-50 rounded-xl shadow-sm border border-purple-100 overflow-hidden">
            {/* 可点击的标题栏 */}
            <div
                className="flex items-center justify-between p-6 cursor-pointer hover:bg-purple-100/50 transition-colors"
                onClick={() => onCollapseChange(!isCollapsed)}
            >
                <h2 className="text-xl font-bold text-purple-800 flex items-center gap-2">
                    <Shield size={20} className="text-purple-600" />
                    管理员面板
                    {currentSession && (
                        <span className="text-sm font-normal text-purple-500">
                            · {currentSession.session_name || currentSession.session_id}
                        </span>
                    )}
                    <motion.div
                        initial={false}
                        animate={{ rotate: isCollapsed ? -90 : 0 }}
                        transition={{ duration: 0.2 }}
                    >
                        <ChevronDown size={18} className="text-purple-400" />
                    </motion.div>
                </h2>
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        // 清除 token 后直接跳转
                        localStorage.removeItem('aapay_token');
                        window.location.href = '/oauth2/sign_out?rd=%2F';
                    }}
                    className="text-sm text-red-500 hover:text-red-600 flex items-center gap-1 px-3 py-1.5 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
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
                                <label className="block text-sm font-medium text-gray-600 mb-2">
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
                                        className="flex-1 h-10 px-3 border border-gray-200 bg-white rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-300"
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
                                                            ? 'bg-purple-100 border-purple-300 text-purple-700'
                                                            : 'bg-white border-gray-200 text-gray-700 hover:border-purple-200'
                                                            }`}
                                                    >
                                                        {session.name}
                                                        {currentSession?.session_id === session.id && (
                                                            <span className="ml-2 text-xs text-purple-600">(当前)</span>
                                                        )}
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteSession(session.id, session.name)}
                                                        className="h-10 w-10 flex items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-400 hover:text-red-500 hover:border-red-200 transition-all"
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
                                    <label className="block text-sm font-medium text-gray-600 mb-2">
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
                                                className="flex-1 h-10 px-3 border border-gray-200 bg-white rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-300"
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
                                                            <label className="text-xs text-gray-500">开始时间</label>
                                                            <input
                                                                type="datetime-local"
                                                                value={phraseValidFrom}
                                                                onChange={(e) => setPhraseValidFrom(e.target.value)}
                                                                className="w-full h-10 px-2 border border-gray-200 rounded-lg text-sm bg-gray-100 appearance-none"
                                                            />
                                                        </div>
                                                        <div className="flex-1">
                                                            <label className="text-xs text-gray-500">结束时间</label>
                                                            <input
                                                                type="datetime-local"
                                                                value={phraseValidUntil}
                                                                onChange={(e) => setPhraseValidUntil(e.target.value)}
                                                                className="w-full h-10 px-2 border border-gray-200 rounded-lg text-sm bg-gray-100 appearance-none"
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
                                                                ? 'bg-green-50 border-green-200'
                                                                : 'bg-gray-50 border-gray-200 opacity-60'
                                                                }`}
                                                        >
                                                            <span className="font-mono font-bold text-gray-700 text-sm">{phrase.phrase}</span>
                                                            <span className="text-xs text-gray-500 flex items-center font-mono flex-shrink-0">
                                                                <Clock size={12} className="mr-1 flex-shrink-0" />
                                                                <span>{formatDateTime(phrase.valid_from)}</span>
                                                                <span className="mx-1">~</span>
                                                                <span>{formatDateTime(phrase.valid_until)}</span>
                                                            </span>
                                                        </div>
                                                        <button
                                                            onClick={() => handleDeletePhrase(phrase.id)}
                                                            className="self-stretch w-10 flex items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-400 hover:text-red-500 hover:border-red-200 transition-all"
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
        </div>
    );
};

export default AdminPanel;

