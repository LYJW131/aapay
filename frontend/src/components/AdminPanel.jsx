import React, { useState, useEffect } from 'react';
import { Shield, Plus, Trash2, Key, Clock, RefreshCw, LogOut, X, FolderOpen } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import * as api from '../services/api';
import { useNotification } from './NotificationProvider';

const AdminPanel = ({ currentSession, onSessionChange, onLogout }) => {
    const { addNotification } = useNotification();
    const [sessions, setSessions] = useState([]);
    const [phrases, setPhrases] = useState([]);
    const [newSessionName, setNewSessionName] = useState('');
    const [showPhraseForm, setShowPhraseForm] = useState(false);
    const [newPhrase, setNewPhrase] = useState('');
    const [phraseValidFrom, setPhraseValidFrom] = useState('');
    const [phraseValidUntil, setPhraseValidUntil] = useState('');
    const [loading, setLoading] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState(null); // session id to confirm delete

    // 加载会话列表
    const loadSessions = async () => {
        try {
            const res = await api.getSessions();
            setSessions(res.data);
        } catch (err) {
            console.error('Failed to load sessions', err);
        }
    };

    // 加载当前会话的分享短语
    const loadPhrases = async () => {
        if (!currentSession) return;
        try {
            const res = await api.getPhrases(currentSession.session_id);
            setPhrases(res.data);
        } catch (err) {
            console.error('Failed to load phrases', err);
        }
    };

    useEffect(() => {
        loadSessions();
    }, []);

    useEffect(() => {
        if (currentSession) {
            loadPhrases();
        }
    }, [currentSession]);

    // 创建会话
    const handleCreateSession = async (e) => {
        e.preventDefault();
        if (!newSessionName.trim()) return;
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
    const handleDeleteSession = async (id) => {
        setLoading(true);
        try {
            await api.deleteSession(id);
            addNotification('会话已删除', 'delete');
            setDeleteConfirm(null);
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
        if (!newPhrase.trim() || !phraseValidFrom || !phraseValidUntil) return;
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
        <div className="bg-gradient-to-r from-purple-50 to-indigo-50 p-6 rounded-xl shadow-sm border border-purple-100">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-purple-800 flex items-center gap-2">
                    <Shield size={20} className="text-purple-600" />
                    管理员面板
                </h2>
                <button
                    onClick={onLogout}
                    className="text-sm text-gray-500 hover:text-red-500 flex items-center gap-1"
                >
                    <LogOut size={14} /> 登出
                </button>
            </div>

            {/* 会话选择 */}
            <div className="mb-6">
                <label className="block text-sm font-medium text-gray-600 mb-2">
                    <FolderOpen size={14} className="inline mr-1" />
                    会话管理
                </label>

                {/* 会话列表 */}
                <div className="space-y-2 mb-3">
                    {sessions.length === 0 ? (
                        <p className="text-gray-400 text-sm py-2">暂无会话，请创建</p>
                    ) : (
                        sessions.map(session => (
                            <div
                                key={session.id}
                                className={`flex items-center justify-between px-3 py-2 rounded-lg border transition-all ${currentSession?.session_id === session.id
                                    ? 'bg-purple-100 border-purple-300'
                                    : 'bg-white border-gray-200 hover:border-purple-200'
                                    }`}
                            >
                                <button
                                    onClick={() => handleSwitchSession(session)}
                                    className="flex-1 text-left font-medium text-gray-700"
                                >
                                    {session.name}
                                    {currentSession?.session_id === session.id && (
                                        <span className="ml-2 text-xs text-purple-600">(当前)</span>
                                    )}
                                </button>
                                <button
                                    onClick={() => setDeleteConfirm(session.id)}
                                    className="text-gray-400 hover:text-red-500 p-1"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        ))
                    )}
                </div>

                {/* 创建新会话 */}
                <form onSubmit={handleCreateSession} className="flex gap-2">
                    <input
                        type="text"
                        value={newSessionName}
                        onChange={(e) => setNewSessionName(e.target.value)}
                        placeholder="新会话名称"
                        className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                        maxLength={50}
                    />
                    <button
                        type="submit"
                        disabled={loading}
                        className="bg-purple-600 text-white px-3 py-2 rounded-lg hover:bg-purple-700 disabled:opacity-50"
                    >
                        <Plus size={18} />
                    </button>
                </form>
            </div>

            {/* 分享短语管理（仅当选中会话时显示） */}
            {currentSession && (
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-gray-600 flex items-center gap-1">
                            <Key size={14} />
                            分享短语
                        </label>
                        <button
                            onClick={() => {
                                if (!showPhraseForm) {
                                    // 设置默认时间：开始时间为当前时刻，结束时间为一天后
                                    const now = new Date();
                                    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                                    // 格式化为 datetime-local 需要的格式 (YYYY-MM-DDTHH:mm)
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
                                setShowPhraseForm(!showPhraseForm);
                            }}
                            className="text-sm text-purple-600 hover:text-purple-800 flex items-center gap-1"
                        >
                            <Plus size={14} /> 新增
                        </button>
                    </div>

                    {/* 新增分享短语表单 */}
                    <AnimatePresence>
                        {showPhraseForm && (
                            <motion.form
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                onSubmit={handleCreatePhrase}
                                className="bg-white p-3 rounded-lg border border-purple-200 mb-3 overflow-hidden"
                            >
                                <input
                                    type="text"
                                    value={newPhrase}
                                    onChange={(e) => setNewPhrase(e.target.value.replace(/[^a-zA-Z0-9]/g, ''))}
                                    placeholder="分享短语 (6-32位字母数字)"
                                    className="w-full px-3 py-2 border rounded-lg text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-purple-300"
                                    minLength={6}
                                    maxLength={32}
                                />
                                <div className="flex gap-2 mb-2">
                                    <div className="flex-1">
                                        <label className="text-xs text-gray-500">开始时间</label>
                                        <input
                                            type="datetime-local"
                                            value={phraseValidFrom}
                                            onChange={(e) => setPhraseValidFrom(e.target.value)}
                                            className="w-full px-2 py-1 border rounded text-sm"
                                        />
                                    </div>
                                    <div className="flex-1">
                                        <label className="text-xs text-gray-500">结束时间</label>
                                        <input
                                            type="datetime-local"
                                            value={phraseValidUntil}
                                            onChange={(e) => setPhraseValidUntil(e.target.value)}
                                            className="w-full px-2 py-1 border rounded text-sm"
                                        />
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        type="submit"
                                        disabled={loading || newPhrase.length < 6}
                                        className="flex-1 bg-purple-600 text-white py-2 rounded-lg text-sm disabled:opacity-50"
                                    >
                                        创建
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setShowPhraseForm(false)}
                                        className="px-3 py-2 bg-gray-100 rounded-lg text-sm"
                                    >
                                        取消
                                    </button>
                                </div>
                            </motion.form>
                        )}
                    </AnimatePresence>

                    {/* 分享短语列表 */}
                    <div className="space-y-2">
                        {phrases.length === 0 ? (
                            <p className="text-gray-400 text-sm py-2">暂无分享短语</p>
                        ) : (
                            phrases.map(phrase => (
                                <div
                                    key={phrase.id}
                                    className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${isPhraseActive(phrase)
                                        ? 'bg-green-50 border border-green-200'
                                        : 'bg-gray-50 border border-gray-200 opacity-60'
                                        }`}
                                >
                                    <div>
                                        <span className="font-mono font-bold text-gray-700">{phrase.phrase}</span>
                                        <div className="text-xs text-gray-500 flex items-center gap-1 mt-1">
                                            <Clock size={10} />
                                            {formatDateTime(phrase.valid_from)} ~ {formatDateTime(phrase.valid_until)}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleDeletePhrase(phrase.id)}
                                        className="text-gray-400 hover:text-red-500 p-1"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}

            {/* 删除确认弹窗 */}
            <AnimatePresence>
                {deleteConfirm && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
                        onClick={() => setDeleteConfirm(null)}
                    >
                        <motion.div
                            initial={{ scale: 0.9 }}
                            animate={{ scale: 1 }}
                            exit={{ scale: 0.9 }}
                            className="bg-white rounded-xl p-6 w-80 shadow-xl"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <h3 className="text-lg font-bold text-gray-800 mb-4">确认删除</h3>
                            <p className="text-gray-600 mb-6">
                                确定要删除这个会话吗？所有相关数据将被永久删除。
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => handleDeleteSession(deleteConfirm)}
                                    disabled={loading}
                                    className="flex-1 bg-red-500 text-white py-2 rounded-lg font-bold hover:bg-red-600 disabled:opacity-50"
                                >
                                    确认删除
                                </button>
                                <button
                                    onClick={() => setDeleteConfirm(null)}
                                    className="flex-1 bg-gray-100 py-2 rounded-lg font-bold hover:bg-gray-200"
                                >
                                    取消
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default AdminPanel;
