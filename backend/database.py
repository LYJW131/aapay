"""
SQLite 数据库模块
提供数据库初始化、连接管理和数据迁移功能
"""

import sqlite3
import json
import os
from contextlib import contextmanager

DATABASE_FILE = "aapay.db"
JSON_DATA_FILE = "data.json"


def get_connection() -> sqlite3.Connection:
    """获取数据库连接"""
    conn = sqlite3.connect(DATABASE_FILE)
    conn.row_factory = sqlite3.Row  # 使结果可以通过列名访问
    conn.execute("PRAGMA foreign_keys = ON")  # 启用外键约束
    return conn


@contextmanager
def get_db():
    """数据库连接上下文管理器"""
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    """初始化数据库表结构"""
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 创建用户表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                avatar TEXT DEFAULT 'default',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # 创建支出表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS expenses (
                id TEXT PRIMARY KEY,
                description TEXT NOT NULL,
                payer_id TEXT NOT NULL,
                amount REAL NOT NULL,
                date TEXT NOT NULL,
                split_method TEXT DEFAULT 'average',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (payer_id) REFERENCES users(id)
            )
        """)
        
        # 创建支出参与者关联表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS expense_participants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                expense_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(expense_id, user_id)
            )
        """)
        
        # 创建索引以提高查询性能
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_expenses_payer ON expenses(payer_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_participants_expense ON expense_participants(expense_id)")
        
    # 尝试迁移现有 JSON 数据
    migrate_from_json()


def migrate_from_json():
    """从 JSON 文件迁移现有数据到 SQLite"""
    if not os.path.exists(JSON_DATA_FILE):
        return
    
    try:
        with open(JSON_DATA_FILE, "r") as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError):
        return
    
    users = data.get("users", [])
    expenses = data.get("expenses", [])
    
    if not users and not expenses:
        return
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 检查是否已有数据（避免重复迁移）
        cursor.execute("SELECT COUNT(*) FROM users")
        if cursor.fetchone()[0] > 0:
            return
        
        # 迁移用户数据
        for user in users:
            cursor.execute(
                "INSERT OR IGNORE INTO users (id, name, avatar) VALUES (?, ?, ?)",
                (user["id"], user["name"], user.get("avatar", "default"))
            )
        
        # 迁移支出数据
        for expense in expenses:
            cursor.execute(
                """INSERT OR IGNORE INTO expenses 
                   (id, description, payer_id, amount, date, split_method, created_at) 
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    expense["id"],
                    expense["description"],
                    expense["payer_id"],
                    expense["amount"],
                    expense["date"],
                    expense.get("split_method", "average"),
                    expense.get("created_at")
                )
            )
            
            # 迁移参与者关系
            for participant_id in expense.get("participants", []):
                cursor.execute(
                    "INSERT OR IGNORE INTO expense_participants (expense_id, user_id) VALUES (?, ?)",
                    (expense["id"], participant_id)
                )
        
        print(f"✅ 已从 JSON 迁移 {len(users)} 个用户和 {len(expenses)} 条支出记录到 SQLite")


# 模块加载时自动初始化数据库
init_db()
