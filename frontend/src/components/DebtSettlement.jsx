import React from 'react';
import { RefreshCcw, ArrowRight } from 'lucide-react';

const DebtSettlement = ({ debts }) => {
    return (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
            <h2 className="text-xl font-bold mb-4 text-gray-800 dark:text-gray-100 flex items-center gap-2">
                <RefreshCcw size={20} className="text-primary" /> 转账结算
            </h2>

            <div className="space-y-4">
                {debts.length > 0 ? (
                    debts.map((debt, idx) => (
                        <div key={idx} className="flex items-center justify-between p-3 bg-red-50 dark:bg-red-900/30 rounded-lg border border-red-100 dark:border-red-800">
                            <div className="flex items-center gap-2">
                                <span className="font-bold text-gray-700 dark:text-gray-200">{debt.from_user}</span>
                                <ArrowRight size={16} className="text-red-400" />
                                <span className="font-bold text-gray-700 dark:text-gray-200">{debt.to_user}</span>
                            </div>
                            <span className="font-bold text-red-500">¥{debt.amount.toFixed(2)}</span>
                        </div>
                    ))
                ) : (
                    <div className="text-center text-green-500 dark:text-green-400 py-6 bg-green-50 dark:bg-green-900/30 rounded-lg border border-green-100 dark:border-green-800">
                        没有待结算的转账
                    </div>
                )}
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-4 text-center">基于最优路径算法计算最少转账次数</p>
        </div>
    );
};

export default DebtSettlement;
