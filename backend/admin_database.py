"""
管理员数据库模块
存储会话列表和分享短语元信息
"""

import sqlite3
import os
from contextlib import contextmanager
from datetime import datetime

ADMIN_DATABASE_FILE = "admin.db"


def get_admin_connection() -> sqlite3.Connection:
    """获取管理员数据库连接"""
    conn = sqlite3.connect(ADMIN_DATABASE_FILE)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def get_admin_db():
    """管理员数据库连接上下文管理器"""
    conn = get_admin_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_admin_db():
    """初始化管理员数据库表结构"""
    with get_admin_db() as conn:
        cursor = conn.cursor()
        
        # 会话表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # 分享短语表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS share_phrases (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                phrase TEXT UNIQUE NOT NULL,
                jwt_token TEXT NOT NULL,
                valid_from DATETIME NOT NULL,
                valid_until DATETIME NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        """)
        
        # 索引
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_phrases_session ON share_phrases(session_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_phrases_phrase ON share_phrases(phrase)")


# 会话数据库目录
SESSIONS_DIR = "sessions"


def get_session_db_path(session_id: str) -> str:
    """获取会话数据库文件路径"""
    return os.path.join(SESSIONS_DIR, f"{session_id}.db")


def ensure_sessions_dir():
    """确保会话目录存在"""
    if not os.path.exists(SESSIONS_DIR):
        os.makedirs(SESSIONS_DIR)


def delete_session_db(session_id: str):
    """删除会话数据库文件"""
    db_path = get_session_db_path(session_id)
    if os.path.exists(db_path):
        os.remove(db_path)


# 模块加载时初始化
ensure_sessions_dir()
init_admin_db()
