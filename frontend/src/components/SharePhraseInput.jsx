import React, { useState } from 'react';
import { Key, ArrowRight, RefreshCw } from 'lucide-react';
import * as api from '../services/api';
import { useNotification } from './NotificationProvider';

const SharePhraseInput = ({ onSuccess, isCompact = false }) => {
    const { addNotification } = useNotification();
    const [phrase, setPhrase] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!phrase.trim() || phrase.length < 6) {
            setError('请输入有效的分享短语（至少6位）');
            return;
        }

        setLoading(true);
        setError('');

        try {
            const res = await api.exchangePhrase(phrase);
            // 保存返回的 token
            if (res.data.token) {
                api.setToken(res.data.token);
            }
            setPhrase('');
            // 添加切换成功的通知
            addNotification('会话切换成功', 'success');
            if (onSuccess) {
                onSuccess(res.data);
            } else {
                // 刷新页面以加载新状态
                window.location.reload();
            }
        } catch (err) {
            const errorMsg = err.response?.data?.detail || '分享短语无效或已过期';
            setError(errorMsg);
            addNotification(errorMsg, 'error');
        } finally {
            setLoading(false);
        }
    };

    // 紧凑模式（用于已认证用户切换会话）
    if (isCompact) {
        return (
            <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                <div className="flex items-center gap-2 mb-3">
                    <RefreshCw size={16} className="text-gray-500" />
                    <span className="text-sm font-medium text-gray-600">切换会话</span>
                </div>
                <form onSubmit={handleSubmit} className="flex gap-2">
                    <input
                        type="text"
                        value={phrase}
                        onChange={(e) => {
                            setPhrase(e.target.value.replace(/[^a-zA-Z0-9]/g, ''));
                            setError('');
                        }}
                        placeholder="输入分享短语"
                        className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        maxLength={32}
                    />
                    <button
                        type="submit"
                        disabled={loading || phrase.length < 6}
                        className="bg-primary text-white px-4 py-2 rounded-lg hover:bg-primary-dark disabled:opacity-50 transition-colors"
                    >
                        {loading ? '...' : <ArrowRight size={18} />}
                    </button>
                </form>
            </div>
        );
    }

    // 完整模式（用于未认证用户）
    return (
        <div className="bg-white p-8 rounded-2xl shadow-lg border border-gray-100 max-w-md mx-auto">
            <div className="text-center mb-6">
                <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Key size={32} className="text-primary" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">
                    欢迎使用 AAPay
                </h2>
                <p className="text-gray-500">
                    请输入分享短语以访问账本
                </p>
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
                        className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl text-center text-lg font-mono tracking-widest focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all"
                        maxLength={32}
                        autoFocus
                    />
                </div>

                {error && (
                    <div className="bg-red-50 text-red-600 px-4 py-2 rounded-lg text-sm text-center">
                        {error}
                    </div>
                )}

                <button
                    type="submit"
                    disabled={loading || phrase.length < 6}
                    className="w-full bg-primary text-white py-3 rounded-xl font-bold text-lg hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                >
                    {loading ? (
                        <>
                            <RefreshCw size={20} className="animate-spin" />
                            验证中...
                        </>
                    ) : (
                        <>
                            进入账本
                            <ArrowRight size={20} />
                        </>
                    )}
                </button>
            </form>

            <p className="text-center text-gray-400 text-sm mt-6">
                没有分享短语？请联系管理员获取
            </p>
        </div>
    );
};

export default SharePhraseInput;
