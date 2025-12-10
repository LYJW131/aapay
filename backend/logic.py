"""
业务逻辑层 - 使用 SQLite 数据库
支持多会话数据库隔离
"""

import os
from typing import List, Dict, Optional
from datetime import datetime
from uuid import uuid4
from collections import defaultdict

from database import get_db, init_db
from admin_database import get_session_db_path

# 会话隔离配置
SESSION_ISOLATION = os.environ.get("SESSION_ISOLATION", "true").lower() == "true"
SHARED_DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "shared.db")


class DataStore:
    """
    数据存储类，支持指定会话 ID 来使用对应的数据库
    """
    
    def __init__(self, session_id: Optional[str] = None, db_path: Optional[str] = None):
        """
        初始化数据存储
        
        Args:
            session_id: 会话 ID，None 时使用默认数据库（向后兼容）
            db_path: 直接指定数据库路径（优先级高于 session_id）
        """
        if db_path:
            self.db_path = db_path
        elif session_id:
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


def get_store(session_id: Optional[str] = None) -> DataStore:
    """
    获取数据存储实例
    
    Args:
        session_id: 会话 ID
    
    Returns:
        DataStore 实例
    """
    # 非隔离模式或共享会话：使用共享数据库
    if not SESSION_ISOLATION or session_id == "shared":
        return DataStore(db_path=SHARED_DB_PATH)
    return DataStore(session_id)

