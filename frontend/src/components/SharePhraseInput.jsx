import React, { useState } from 'react';
import { Key, ArrowRight, RefreshCw, LogOut, Shield } from 'lucide-react';
import * as api from '../services/api';
import { useNotification } from './NotificationProvider';

const SharePhraseInput = ({ onSuccess, isCompact = false, onLogout }) => {
    const { addNotification } = useNotification();
    const [phrase, setPhrase] = useState('');
    const [loading, setLoading] = useState(false);
    const [adminLoading, setAdminLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!phrase.trim() || phrase.length < 6) {
            addNotification('请输入有效的分享短语（至少6位）', 'error');
            return;
        }

        setLoading(true);
        setError('');

        try {
            const res = await api.exchangePhrase(phrase);
            const newToken = res.data.token;
            const currentToken = api.getToken();

            // 检查是否与当前会话相同
            if (newToken && newToken === currentToken) {
                addNotification('您已在当前会话中', 'info');
                setPhrase('');
                return;
            }

            // 保存新 token
            if (newToken) {
                api.setToken(newToken);
            }
            setPhrase('');
            addNotification('登录成功', 'success');
            if (onSuccess) {
                onSuccess(res.data);
            } else {
                // 刷新页面以加载新状态
                window.location.reload();
            }
        } catch (err) {
            const errorMsg = err.response?.data?.detail || '分享短语无效或已过期';
            addNotification(errorMsg, 'error');
        } finally {
            setLoading(false);
        }
    };

    // 紧凑模式（用于已认证用户切换会话）
    if (isCompact) {
        return (
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2 mb-4">
                    <RefreshCw size={20} className="text-primary" />
                    切换会话
                </h2>
                <form onSubmit={handleSubmit} className="flex gap-2 mb-4">
                    <input
                        type="text"
                        value={phrase}
                        onChange={(e) => {
                            setPhrase(e.target.value.replace(/[^a-zA-Z0-9]/g, ''));
                            setError('');
                        }}
                        placeholder="输入分享短语"
                        className="flex-1 h-10 px-3 border border-gray-200 bg-white rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                        maxLength={32}
                    />
                    <button
                        type="submit"
                        disabled={loading || phrase.length < 6}
                        className="h-10 w-10 flex items-center justify-center bg-primary text-white rounded-lg hover:bg-primary-dark disabled:opacity-50 transition-colors"
                    >
                        {loading ? '...' : <ArrowRight size={18} />}
                    </button>
                </form>
                {onLogout && (
                    <button
                        onClick={onLogout}
                        className="w-full flex items-center justify-center gap-2 text-red-500 bg-red-50 hover:bg-red-100 py-2 rounded-lg transition-colors text-sm"
                    >
                        <LogOut size={16} />
                        退出登录
                    </button>
                )}
            </div>
        );
    }

    // 完整模式（用于未认证用户）
    return (
        <div className="bg-white p-8 rounded-2xl shadow-lg border border-gray-100 w-full max-w-lg mx-auto">
            <div className="text-center mb-6">
                <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Key size={32} className="text-primary" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800">
                    欢迎使用 AAPay
                </h2>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <input
                        type="text"
                        value={phrase}
                        onChange={(e) => {
                            setPhrase(e.target.value.replace(/[^a-zA-Z0-9]/g, ''));
                            setError('');
                        }}
                        placeholder="分享短语"
                        className="w-full h-10 px-3 border border-gray-200 rounded-lg text-center font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
                        maxLength={32}
                        autoFocus
                    />
                </div>

                <button
                    type="submit"
                    disabled={loading || phrase.length < 6}
                    className="w-full h-10 bg-primary text-white rounded-lg font-bold hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                >
                    {loading ? (
                        <>
                            <RefreshCw size={18} className="animate-spin" />
                            验证中...
                        </>
                    ) : (
                        <>
                            进入账本
                            <ArrowRight size={18} />
                        </>
                    )}
                </button>
            </form>

            <div className="mt-6 pt-4 border-t border-gray-100">
                <button
                    onClick={() => {
                        setAdminLoading(true);
                        window.location.href = '/oauth2/sign_in?rd=%2F';
                    }}
                    disabled={adminLoading}
                    className="w-full h-10 flex items-center justify-center gap-2 text-gray-600 hover:text-primary border border-gray-200 rounded-lg hover:border-primary/50 transition-colors disabled:opacity-50"
                >
                    {adminLoading ? (
                        <>
                            <RefreshCw size={16} className="animate-spin" />
                            跳转中...
                        </>
                    ) : (
                        <>
                            <Shield size={16} />
                            管理员登录
                        </>
                    )}
                </button>
            </div>
        </div>
    );
};

export default SharePhraseInput;
