/**
 * 计算债务清算方案（最优转账次数算法）
 * 
 * @param {Array} expenses - 支出记录数组
 * @param {Array} users - 用户数组，用于获取用户名
 * @returns {Array} 转账方案 [{from_user, to_user, amount}, ...]
 */
export function calculateDebts(expenses, users) {
    const balances = {};
    const userMap = {};

    // 构建用户 ID -> 名称映射
    users.forEach(u => {
        userMap[u.id] = u.name;
        balances[u.id] = 0;
    });

    // 计算每个人的余额
    expenses.forEach(exp => {
        const payer = exp.payer_id;
        const amount = exp.amount;
        const participants = exp.participants;

        // 付款人支付了全额（收入）
        balances[payer] = (balances[payer] || 0) + amount;

        // 参与者分摊（支出）
        const splitAmount = amount / participants.length;
        participants.forEach(p => {
            balances[p] = (balances[p] || 0) - splitAmount;
        });
    });

    // 分离债务人和债权人
    const debtors = [];   // 欠钱的人（余额 < 0）
    const creditors = []; // 被欠钱的人（余额 > 0）

    Object.entries(balances).forEach(([uid, amount]) => {
        const rounded = Math.round(amount * 100) / 100;
        if (rounded < -0.01) {
            debtors.push({ id: uid, amount: rounded });
        } else if (rounded > 0.01) {
            creditors.push({ id: uid, amount: rounded });
        }
    });

    // 排序：债务人按金额升序（最负的在前），债权人按金额降序
    debtors.sort((a, b) => a.amount - b.amount);
    creditors.sort((a, b) => b.amount - a.amount);

    // 计算最优转账方案
    const transfers = [];
    let i = 0, j = 0;

    while (i < debtors.length && j < creditors.length) {
        const debtor = debtors[i];
        const creditor = creditors[j];

        const transferAmount = Math.min(Math.abs(debtor.amount), creditor.amount);

        transfers.push({
            from_user: userMap[debtor.id] || 'Unknown',
            to_user: userMap[creditor.id] || 'Unknown',
            amount: Math.round(transferAmount * 100) / 100
        });

        debtor.amount += transferAmount;
        creditor.amount -= transferAmount;

        if (Math.abs(debtor.amount) < 0.01) i++;
        if (creditor.amount < 0.01) j++;
    }

    return transfers;
}
