"""
业务逻辑层 - 使用 SQLite 数据库
支持多会话数据库隔离
"""

from typing import List, Dict, Optional
from datetime import datetime
from uuid import uuid4
from collections import defaultdict

from database import get_db, init_db
from admin_database import get_session_db_path


class DataStore:
    """
    数据存储类，支持指定会话 ID 来使用对应的数据库
    """
    
    def __init__(self, session_id: Optional[str] = None):
        """
        初始化数据存储
        
        Args:
            session_id: 会话 ID，None 时使用默认数据库（向后兼容）
        """
        if session_id:
            self.db_path = get_session_db_path(session_id)
        else:
            self.db_path = None  # 使用默认数据库
        # 确保数据库已初始化
        init_db(self.db_path)

    def add_user(self, name: str, avatar: str = None) -> Dict:
        """添加新用户"""
        with get_db(self.db_path) as conn:
            cursor = conn.cursor()
            
            # 检查用户数量
            cursor.execute("SELECT COUNT(*) FROM users")
            if cursor.fetchone()[0] >= 20:
                raise ValueError("Max 20 users allowed")
            
            # 检查用户名重复
            cursor.execute("SELECT id FROM users WHERE name = ?", (name,))
            if cursor.fetchone():
                raise ValueError("User already exists")
            
            user_id = str(uuid4())
            avatar = avatar or "default"
            
            cursor.execute(
                "INSERT INTO users (id, name, avatar) VALUES (?, ?, ?)",
                (user_id, name, avatar)
            )
            
            return {"id": user_id, "name": name, "avatar": avatar}

    def delete_user(self, user_id: str):
        """删除用户"""
        with get_db(self.db_path) as conn:
            cursor = conn.cursor()
            
            # 检查用户是否在支出中被引用
            cursor.execute(
                "SELECT id FROM expenses WHERE payer_id = ?", (user_id,)
            )
            if cursor.fetchone():
                raise ValueError("Cannot delete user involved in expenses")
            
            cursor.execute(
                "SELECT expense_id FROM expense_participants WHERE user_id = ?", 
                (user_id,)
            )
            if cursor.fetchone():
                raise ValueError("Cannot delete user involved in expenses")
            
            cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))

    def update_user(self, user_id: str, new_name: str, new_avatar: str = None) -> Dict:
        """更新用户信息"""
        with get_db(self.db_path) as conn:
            cursor = conn.cursor()
            
            # 检查用户存在
            cursor.execute("SELECT id, avatar FROM users WHERE id = ?", (user_id,))
            user = cursor.fetchone()
            if not user:
                raise ValueError("User not found")
            
            # 检查名称重复
            cursor.execute(
                "SELECT id FROM users WHERE name = ? AND id != ?", 
                (new_name, user_id)
            )
            if cursor.fetchone():
                raise ValueError("Name already exists")
            
            avatar = new_avatar if new_avatar is not None else user["avatar"]
            
            cursor.execute(
                "UPDATE users SET name = ?, avatar = ? WHERE id = ?",
                (new_name, avatar, user_id)
            )
            
            return {"id": user_id, "name": new_name, "avatar": avatar}

    def get_users(self) -> List[Dict]:
        """获取所有用户"""
        with get_db(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, name, avatar FROM users ORDER BY created_at")
            return [dict(row) for row in cursor.fetchall()]

    def add_expense(
        self, 
        description: str, 
        payer_id: str, 
        amount: float, 
        date_str: str, 
        participants: List[str], 
        split_method: str = "average"
    ) -> Dict:
        """添加支出记录"""
        if not participants:
            raise ValueError("At least one participant required")
        
        expense_id = str(uuid4())
        created_at = datetime.now().isoformat()
        
        with get_db(self.db_path) as conn:
            cursor = conn.cursor()
            
            # 插入支出记录
            cursor.execute(
                """INSERT INTO expenses 
                   (id, description, payer_id, amount, date, split_method, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (expense_id, description, payer_id, amount, date_str, split_method, created_at)
            )
            
            # 插入参与者关系
            for participant_id in participants:
                cursor.execute(
                    "INSERT INTO expense_participants (expense_id, user_id) VALUES (?, ?)",
                    (expense_id, participant_id)
                )
        
        return {
            "id": expense_id,
            "description": description,
            "payer_id": payer_id,
            "amount": amount,
            "date": date_str,
            "participants": participants,
            "split_method": split_method,
            "created_at": created_at
        }

    def delete_expense(self, expense_id: str):
        """删除支出记录"""
        with get_db(self.db_path) as conn:
            cursor = conn.cursor()
            
            cursor.execute("SELECT id FROM expenses WHERE id = ?", (expense_id,))
            if not cursor.fetchone():
                raise ValueError("Expense not found")
            
            # 外键约束会自动删除关联的 expense_participants
            cursor.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))

    def get_expenses(self, date_filter: str = None) -> List[Dict]:
        """获取支出记录"""
        with get_db(self.db_path) as conn:
            cursor = conn.cursor()
            
            if date_filter:
                cursor.execute(
                    """SELECT id, description, payer_id, amount, date, split_method, created_at
                       FROM expenses WHERE date = ? ORDER BY created_at DESC""",
                    (date_filter,)
                )
            else:
                cursor.execute(
                    """SELECT id, description, payer_id, amount, date, split_method, created_at
                       FROM expenses ORDER BY created_at DESC"""
                )
            
            expenses = []
            for row in cursor.fetchall():
                expense = dict(row)
                # 获取参与者列表
                cursor.execute(
                    "SELECT user_id FROM expense_participants WHERE expense_id = ?",
                    (expense["id"],)
                )
                expense["participants"] = [p["user_id"] for p in cursor.fetchall()]
                expenses.append(expense)
            
            return expenses

    def get_daily_summary(self) -> Dict[str, Dict[str, float]]:
        """获取每日支出汇总"""
        with get_db(self.db_path) as conn:
            cursor = conn.cursor()
            
            # 按日期和付款人分组统计
            cursor.execute(
                """SELECT date, payer_id, SUM(amount) as total
                   FROM expenses 
                   GROUP BY date, payer_id"""
            )
            
            summary = defaultdict(lambda: defaultdict(float))
            for row in cursor.fetchall():
                summary[row["date"]][row["payer_id"]] = row["total"]
            
            return dict(summary)

    def calculate_debts(self) -> List[Dict]:
        """计算债务清算方案"""
        balances = defaultdict(float)
        
        with get_db(self.db_path) as conn:
            cursor = conn.cursor()
            
            # 获取所有支出及其参与者
            cursor.execute(
                """SELECT e.id, e.payer_id, e.amount, ep.user_id as participant_id
                   FROM expenses e
                   JOIN expense_participants ep ON e.id = ep.expense_id"""
            )
            
            # 按支出 ID 分组计算
            expenses_data = defaultdict(lambda: {"payer_id": None, "amount": 0, "participants": []})
            
            for row in cursor.fetchall():
                exp_id = row["id"]
                expenses_data[exp_id]["payer_id"] = row["payer_id"]
                expenses_data[exp_id]["amount"] = row["amount"]
                expenses_data[exp_id]["participants"].append(row["participant_id"])
        
        # 计算余额
        for exp_id, exp in expenses_data.items():
            payer = exp["payer_id"]
            amount = exp["amount"]
            participants = exp["participants"]
            
            # 付款人支付了全额
            balances[payer] += amount
            
            # 参与者分摊
            split_amount = amount / len(participants)
            for p in participants:
                balances[p] -= split_amount
        
        # 分离债务人和债权人
        debtors = []
        creditors = []
        
        for uid, amount in balances.items():
            amount = round(amount, 2)
            if amount < -0.01:
                debtors.append({"id": uid, "amount": amount})
            elif amount > 0.01:
                creditors.append({"id": uid, "amount": amount})
        
        debtors.sort(key=lambda x: x["amount"])  # 升序（最负的在前）
        creditors.sort(key=lambda x: x["amount"], reverse=True)  # 降序
        
        # 计算最优转账方案
        transfers = []
        i, j = 0, 0
        
        while i < len(debtors) and j < len(creditors):
            debtor = debtors[i]
            creditor = creditors[j]
            
            amount = min(abs(debtor["amount"]), creditor["amount"])
            transfers.append({
                "from": debtor["id"],
                "to": creditor["id"],
                "amount": round(amount, 2)
            })
            
            debtor["amount"] += amount
            creditor["amount"] -= amount
            
            if abs(debtor["amount"]) < 0.01:
                i += 1
            if creditor["amount"] < 0.01:
                j += 1
        
        return transfers


def get_store(session_id: Optional[str] = None) -> DataStore:
    """
    获取数据存储实例
    
    Args:
        session_id: 会话 ID
    
    Returns:
        DataStore 实例
    """
    return DataStore(session_id)

