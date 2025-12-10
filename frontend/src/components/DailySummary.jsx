
import React, { useMemo } from 'react';
import { History } from 'lucide-react';
import * as api from '../services/api';

const DailySummary = ({ expenses, users, summary, selectedDate }) => {

    // Filter expenses based on the global selectedDate passed as prop
    const filteredExpenses = useMemo(() => {
        return expenses.filter(e => e.date === selectedDate).reverse();
    }, [expenses, selectedDate]);

    const getUserName = (id) => users.find(u => u.id === id)?.name || '未知';

    const handleDelete = async (id) => {
        if (!confirm('确定删除这条支出记录吗？')) return;
        try {
            await api.deleteExpense(id);
        } catch (err) {
            alert('删除失败');
        }
    };

    // Helper to format time from created_at or fallback
    const formatTime = (isoString) => {
        if (!isoString) return '';
        const date = new Date(isoString);
        return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    };

    return (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 flex flex-col gap-6">
            <div>
                <h2 className="text-xl font-bold mb-4 text-gray-800 dark:text-gray-100 flex items-center justify-between">
                    <span className="flex items-center gap-2"><History size={20} className="text-primary" /> 支出记录</span>
                </h2>
            </div>

            {/* List */}
            <div className="space-y-4">
                {filteredExpenses.map(exp => (
                    <div key={exp.id} className="bg-[#f5f7fa] dark:bg-gray-700 rounded-xl p-4 relative">
                        {/* Top Row: Description and Amount */}
                        <div className="flex justify-between items-start mb-1">
                            <div className="font-bold text-gray-900 dark:text-gray-100 text-lg">{exp.description}</div>
                            <div className="font-bold text-lg text-primary">¥{exp.amount.toFixed(2)}</div>
                        </div>

                        {/* Second Row: Payer, Split Type, Time, Delete */}
                        <div className="flex justify-between items-center text-sm text-gray-500 dark:text-gray-400 mb-3">
                            <div className="flex items-center gap-1">
                                <span>{getUserName(exp.payer_id)}支付</span>
                                <span>·</span>
                                <span>平均分摊</span>
                                {exp.created_at && (
                                    <>
                                        <span>·</span>
                                        <span>{formatTime(exp.created_at)}</span>
                                    </>
                                )}
                            </div>
                            <button
                                onClick={() => handleDelete(exp.id)}
                                className="text-red-400 hover:text-red-600 font-normal hover:underline text-xs"
                            >
                                删除
                            </button>
                        </div>

                        {/* Divider */}
                        <div className="border-t border-gray-200 dark:border-gray-600 mb-2"></div>

                        {/* Third Row: Split Details (Flowing text) */}
                        <div className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed text-left break-all">
                            {exp.participants.map((pid, idx) => (
                                <span key={pid}>
                                    {getUserName(pid)}: ¥{(exp.amount / exp.participants.length).toFixed(2)}
                                    {idx < exp.participants.length - 1 ? ' / ' : ''}
                                </span>
                            ))}
                        </div>
                    </div>
                ))}
                {filteredExpenses.length === 0 && (
                    <div className="text-center text-gray-400 dark:text-gray-500 py-10 bg-gray-50 dark:bg-gray-700 rounded-xl">
                        暂无支出记录
                    </div>
                )}
            </div>
        </div>
    );
};

export default DailySummary;

