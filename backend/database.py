"""
SQLite 数据库模块
提供数据库初始化、连接管理功能
支持动态选择数据库文件路径
"""

import sqlite3
import os
from contextlib import contextmanager
from typing import Optional

# 默认数据库路径（仅用于向后兼容）
DEFAULT_DATABASE_FILE = "aapay.db"


def get_connection(db_path: Optional[str] = None) -> sqlite3.Connection:
    """
    获取数据库连接
    
    Args:
        db_path: 数据库文件路径，None 时使用默认路径
    
    Returns:
        sqlite3.Connection 对象
    """
    path = db_path or DEFAULT_DATABASE_FILE
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row  # 使结果可以通过列名访问
    conn.execute("PRAGMA foreign_keys = ON")  # 启用外键约束
    return conn


@contextmanager
def get_db(db_path: Optional[str] = None):
    """
    数据库连接上下文管理器
    
    Args:
        db_path: 数据库文件路径，None 时使用默认路径
    """
    conn = get_connection(db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(db_path: Optional[str] = None):
    """
    初始化数据库表结构
    
    Args:
        db_path: 数据库文件路径，None 时使用默认路径
    """
    with get_db(db_path) as conn:
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

