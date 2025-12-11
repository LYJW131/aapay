import React, { useState, useEffect } from 'react';
import { DollarSign } from 'lucide-react';
import * as api from '../services/api';

const STORAGE_KEY_PAYER = 'aapay_last_payer';
const STORAGE_KEY_PARTICIPANTS = 'aapay_last_participants';

const ExpenseForm = ({ users, defaultDate }) => {
    const [formData, setFormData] = useState(() => {
        // 从 localStorage 读取上次的付款人
        const savedPayer = localStorage.getItem(STORAGE_KEY_PAYER) || '';
        return {
            description: '',
            amount: '',
            payer_id: savedPayer,
            participants: [],
            date: defaultDate || new Date().toISOString().split('T')[0]
        };
    });

    // Update local date when global defaultDate changes
    useEffect(() => {
        if (defaultDate) {
            setFormData(prev => ({ ...prev, date: defaultDate }));
        }
    }, [defaultDate]);

    // 用于追踪已知用户ID，检测新增用户
    const [knownUserIds, setKnownUserIds] = useState([]);

    // 当用户列表变化时处理参与者
    useEffect(() => {
        if (!users || users.length === 0) return;

        const currentUserIds = users.map(u => u.id);
        const savedParticipants = localStorage.getItem(STORAGE_KEY_PARTICIPANTS);

        // 首次加载：检查本地存储
        if (knownUserIds.length === 0) {
            // 验证付款人ID是否有效
            setFormData(prev => {
                const isPayerValid = currentUserIds.includes(prev.payer_id);
                return isPayerValid ? prev : { ...prev, payer_id: '' };
            });

            if (savedParticipants) {
                // 有本地存储记录，从中恢复（过滤无效ID）
                try {
                    const parsed = JSON.parse(savedParticipants);
                    const validIds = parsed.filter(id => currentUserIds.includes(id));
                    setFormData(prev => ({ ...prev, participants: validIds }));
                } catch (e) {
                    // 解析失败，全选并存储
                    setFormData(prev => ({ ...prev, participants: currentUserIds }));
                    localStorage.setItem(STORAGE_KEY_PARTICIPANTS, JSON.stringify(currentUserIds));
                }
            } else {
                // 无本地存储，全选并存储
                setFormData(prev => ({ ...prev, participants: currentUserIds }));
                localStorage.setItem(STORAGE_KEY_PARTICIPANTS, JSON.stringify(currentUserIds));
            }
            setKnownUserIds(currentUserIds);
            return;
        }

        // 检测新增用户
        const newUserIds = currentUserIds.filter(id => !knownUserIds.includes(id));
        if (newUserIds.length > 0) {
            // 将新用户添加到参与者
            setFormData(prev => {
                const updatedParticipants = [...prev.participants, ...newUserIds];
                return { ...prev, participants: updatedParticipants };
            });
        }

        // 检测删除用户，从参与者中移除，同时验证付款人
        const deletedUserIds = knownUserIds.filter(id => !currentUserIds.includes(id));
        if (deletedUserIds.length > 0) {
            setFormData(prev => {
                const isPayerValid = currentUserIds.includes(prev.payer_id);
                return {
                    ...prev,
                    participants: prev.participants.filter(id => currentUserIds.includes(id)),
                    payer_id: isPayerValid ? prev.payer_id : ''
                };
            });
        }

        // 更新已知用户列表
        setKnownUserIds(currentUserIds);
    }, [users]);

    // 当付款人变化时保存到 localStorage
    useEffect(() => {
        if (formData.payer_id) {
            localStorage.setItem(STORAGE_KEY_PAYER, formData.payer_id);
        }
    }, [formData.payer_id]);

    // 当参与者变化时保存到 localStorage
    useEffect(() => {
        if (formData.participants.length > 0) {
            localStorage.setItem(STORAGE_KEY_PARTICIPANTS, JSON.stringify(formData.participants));
        }
    }, [formData.participants]);

    // 验证常量
    const MAX_DESCRIPTION_LENGTH = 15;
    const MIN_AMOUNT = 0.01;
    const MAX_AMOUNT = 999999.99;

    const handleSubmit = async (e) => {
        e.preventDefault();

        const description = formData.description.trim();
        const amount = parseFloat(formData.amount);

        // 验证用途
        if (!description) {
            alert('请填写用途');
            return;
        }
        if (description.length > MAX_DESCRIPTION_LENGTH) {
            alert(`用途不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符`);
            return;
        }

        // 验证金额
        if (!formData.amount || isNaN(amount)) {
            alert('请填写有效的金额');
            return;
        }
        if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
            alert(`金额必须在 ${MIN_AMOUNT} 到 ${MAX_AMOUNT.toLocaleString()} 之间`);
            return;
        }

        // 验证付款人和参与者
        if (!formData.payer_id) {
            alert('请选择付款人');
            return;
        }
        if (formData.participants.length === 0) {
            alert('请选择至少一位参与者');
            return;
        }

        try {
            await api.createExpense({
                ...formData,
                description,
                amount
            });
            // 提交后只重置描述和金额，保留参与者选择
            setFormData(prev => ({
                ...prev,
                description: '',
                amount: ''
                // participants 保持不变
            }));
        } catch (err) {
            alert('添加失败，请检查输入是否符合要求');
        }
    };

    const toggleParticipant = (uid) => {
        setFormData(prev => {
            const newParticipants = prev.participants.includes(uid)
                ? prev.participants.filter(id => id !== uid)
                : [...prev.participants, uid];
            return { ...prev, participants: newParticipants };
        });
    };

    const handleSelectAll = () => {
        if (formData.participants.length === users.length) {
            setFormData(prev => ({ ...prev, participants: [] }));
        } else {
            setFormData({ ...formData, participants: users.map(u => u.id) });
        }
    };

    return (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-apple-lg shadow-sm border border-gray-100 dark:border-gray-700">
            <h2 className="text-xl font-bold mb-4 text-gray-800 dark:text-gray-100 flex items-center gap-2">
                <DollarSign size={20} className="text-primary" /> 支出记账
            </h2>

            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1 flex justify-between">
                        <span>用途</span>
                        <span className={`text-xs ${formData.description.length > MAX_DESCRIPTION_LENGTH ? 'text-red-500' : 'text-gray-400'}`}>
                            {formData.description.length}/{MAX_DESCRIPTION_LENGTH}
                        </span>
                    </label>
                    <input
                        type="text"
                        value={formData.description}
                        onChange={e => setFormData({ ...formData, description: e.target.value })}
                        placeholder="例如：午饭"
                        maxLength={MAX_DESCRIPTION_LENGTH}
                        className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-apple-sm focus:outline-none focus:ring-2 focus:ring-primary/50 bg-white dark:bg-gray-700 dark:text-gray-100"
                    />
                </div>

                <div className="flex gap-4">
                    <div className="flex-1">
                        <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1">金额</label>
                        <input
                            type="number"
                            value={formData.amount}
                            onChange={e => setFormData({ ...formData, amount: e.target.value })}
                            placeholder="0.00"
                            min={MIN_AMOUNT}
                            max={MAX_AMOUNT}
                            step="0.01"
                            className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-apple-sm focus:outline-none focus:ring-2 focus:ring-primary/50 bg-white dark:bg-gray-700 dark:text-gray-100"
                        />
                    </div>
                </div>

                <div>
                    <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1">付款人</label>
                    <select
                        value={formData.payer_id}
                        onChange={e => setFormData({ ...formData, payer_id: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-apple-sm focus:outline-none focus:ring-2 focus:ring-primary/50 bg-white dark:bg-gray-700 dark:text-gray-100"
                    >
                        <option value="">选择付款人</option>
                        {users.map(u => (
                            <option key={u.id} value={u.id}>{u.name}</option>
                        ))}
                    </select>
                </div>

                <div>
                    <label className="block text-sm text-gray-500 mb-2 flex justify-between items-center">
                        <span>参与者 ({formData.participants.length}/{users.length})</span>
                        <button
                            type="button"
                            onClick={handleSelectAll}
                            className={`px-2.5 py-1 text-xs rounded-full transition-all ${formData.participants.length === users.length
                                ? 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                                : 'bg-primary/10 text-primary hover:bg-primary/20'
                                }`}
                        >
                            {formData.participants.length === users.length ? '取消全选' : '全选'}
                        </button>
                    </label>
                    <div className="flex flex-wrap gap-2">
                        {users.map(u => (
                            <button
                                key={u.id}
                                type="button"
                                onClick={() => toggleParticipant(u.id)}
                                className={`px-3 py-1 text-sm rounded-full border transition-colors ${formData.participants.includes(u.id)
                                    ? 'bg-primary text-white border-primary'
                                    : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:border-primary'
                                    }`}
                            >
                                {u.name}
                            </button>
                        ))}
                    </div>
                </div>

                <button
                    type="submit"
                    className="w-full bg-gradient-to-r from-primary to-primary-dark text-white py-3 rounded-apple font-bold hover:shadow-lg transition-transform active:scale-95"
                >
                    添加支出记录
                </button>
            </form>
        </div>
    );
};

export default ExpenseForm;
