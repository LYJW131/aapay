import React, { useState } from 'react';
import { QrCode, Copy, Check, X, Share2, ArrowRight, LogOut, RefreshCw } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { motion, AnimatePresence } from 'framer-motion';
import * as api from '../services/api';
import { useNotification } from './NotificationProvider';

const ShareSessionCard = ({ sessionName, onSuccess, onLogout }) => {
    const { addNotification } = useNotification();
    const [showQrModal, setShowQrModal] = useState(false);
    const [linkCopied, setLinkCopied] = useState(false);
    const [phrase, setPhrase] = useState('');
    const [loading, setLoading] = useState(false);

    // 生成带 JWT 的分享链接
    const getShareUrl = () => {
        const token = api.getToken();
        if (!token) return null;
        const baseUrl = window.location.origin + window.location.pathname;
        return `${baseUrl}#jwt=${encodeURIComponent(token)}`;
    };

    // 复制链接到剪贴板
    const handleCopyLink = async () => {
        const url = getShareUrl();
        if (!url) {
            addNotification('获取分享链接失败', 'error');
            return;
        }
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

    const handlePhraseSubmit = async (e) => {
        e.preventDefault();
        const trimmedPhrase = phrase.trim();
        if (!trimmedPhrase || trimmedPhrase.length < 3) {
            addNotification('请输入有效的分享短语（至少3位）', 'error');
            return;
        }
        if (!/^[a-zA-Z0-9]+$/.test(trimmedPhrase)) {
            addNotification('分享短语只能包含大小写字母和数字', 'error');
            return;
        }

        setLoading(true);
        try {
            const res = await api.exchangePhrase(trimmedPhrase);
            const newToken = res.data.token;
            const currentToken = api.getToken();

            if (newToken && newToken === currentToken) {
                addNotification('您已在当前会话中', 'info');
                setPhrase('');
                return;
            }

            if (newToken) {
                api.setToken(newToken);
            }
            setPhrase('');
            addNotification('登录成功', 'success');
            if (onSuccess) {
                onSuccess(res.data);
            } else {
                window.location.reload();
            }
        } catch (err) {
            const errorMsg = err.response?.data?.detail || '分享短语无效或已过期';
            addNotification(errorMsg, 'error');
        } finally {
            setLoading(false);
        }
    };

    const shareUrl = getShareUrl();

    if (!shareUrl) return null;

    return (
        <>
            <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
                <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2 mb-4">
                    <Share2 size={20} className="text-primary" />
                    会话管理
                </h2>

                <form onSubmit={handlePhraseSubmit} className="flex gap-2 mb-4">
                    <input
                        type="text"
                        value={phrase}
                        onChange={(e) => setPhrase(e.target.value)}
                        placeholder="输入分享短语切换会话"
                        className="flex-1 h-10 px-3 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 dark:text-gray-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                        maxLength={16}
                    />
                    <button
                        type="submit"
                        disabled={loading || phrase.length < 3}
                        className="h-10 w-10 flex items-center justify-center bg-primary text-white rounded-lg hover:bg-primary-dark disabled:opacity-50 transition-colors"
                        title="切换会话"
                    >
                        {loading ? <RefreshCw size={18} className="animate-spin" /> : <ArrowRight size={18} />}
                    </button>
                    <button
                        type="button"
                        onClick={() => setShowQrModal(true)}
                        className="h-10 w-10 flex items-center justify-center rounded-lg border border-purple-300 dark:border-purple-700 bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-800/50 transition-all"
                        title="显示二维码"
                    >
                        <QrCode size={18} />
                    </button>
                </form>

                {onLogout && (
                    <button
                        onClick={onLogout}
                        className="w-full h-10 flex items-center justify-center gap-2 text-red-500 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg transition-colors text-sm font-medium"
                    >
                        <LogOut size={16} />
                        退出登录
                    </button>
                )}
            </div>

            {/* 二维码模态框 */}
            <AnimatePresence>
                {showQrModal && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
                        onClick={() => setShowQrModal(false)}
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
                                    分享会话
                                </h3>
                                <button
                                    onClick={() => setShowQrModal(false)}
                                    className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                                >
                                    <X size={20} />
                                </button>
                            </div>

                            {/* 会话信息 */}
                            {sessionName && (
                                <div className="mb-4 px-3 py-2 rounded-lg border bg-primary/10 border-primary/30">
                                    <p className="font-bold text-center text-gray-700 dark:text-gray-200">
                                        {sessionName}
                                    </p>
                                </div>
                            )}

                            {/* 二维码 */}
                            <div className="flex justify-center mb-4 p-4 bg-white rounded-xl">
                                <QRCodeSVG
                                    value={shareUrl}
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
                                        {shareUrl}
                                    </p>
                                </div>
                                <button
                                    onClick={handleCopyLink}
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
        </>
    );
};


export default ShareSessionCard;
