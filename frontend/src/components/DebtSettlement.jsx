import React from 'react';
import { RefreshCcw, ArrowRight } from 'lucide-react';

const DebtSettlement = ({ debts }) => {
    return (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h2 className="text-xl font-bold mb-4 text-gray-800 flex items-center gap-2">
                <RefreshCcw size={20} className="text-primary" /> 转账结算
            </h2>

            <div className="space-y-4">
                {debts.length > 0 ? (
                    debts.map((debt, idx) => (
                        <div key={idx} className="flex items-center justify-between p-3 bg-red-50 rounded-lg border border-red-100">
                            <div className="flex items-center gap-2">
                                <span className="font-bold text-gray-700">{debt.from_user}</span>
                                <ArrowRight size={16} className="text-red-400" />
                                <span className="font-bold text-gray-700">{debt.to_user}</span>
                            </div>
                            <span className="font-bold text-red-500">¥{debt.amount.toFixed(2)}</span>
                        </div>
                    ))
                ) : (
                    <div className="text-center text-green-500 py-6 bg-green-50 rounded-lg border border-green-100">
                        没有待结算的转账
                    </div>
                )}
            </div>
            <p className="text-xs text-gray-400 mt-4 text-center">基于最优路径算法计算最少转账次数</p>
        </div>
    );
};

export default DebtSettlement;
