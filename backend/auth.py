"""
JWT 认证模块
提供 JWT 创建、验证和请求认证功能
"""

from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any
import jwt
from fastapi import Request, HTTPException, Cookie
from functools import wraps

# ==================== JWT 配置 ====================
# TODO: 部署时通过环境变量 JWT_SECRET 配置
# import os
# JWT_SECRET = os.environ.get("JWT_SECRET", "your-fallback-secret")
JWT_SECRET = "dev-secret-key-change-in-production"
JWT_ALGORITHM = "HS256"
JWT_HEADER_NAME = "Authorization"  # 使用 Authorization header
# =================================================


def create_jwt(payload: Dict[str, Any], expires_delta: timedelta) -> str:
    """
    创建 JWT token
    
    Args:
        payload: JWT 载荷数据
        expires_delta: 过期时间增量
    
    Returns:
        JWT token 字符串
    """
    to_encode = payload.copy()
    expire = datetime.now(timezone.utc) + expires_delta
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_jwt(token: str) -> Optional[Dict[str, Any]]:
    """
    解码并验证 JWT token
    
    Args:
        token: JWT token 字符串
    
    Returns:
        解码后的载荷数据，验证失败返回 None
    """
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def create_admin_jwt(session_id: str) -> str:
    """
    创建管理员 JWT（1天有效期）
    
    Args:
        session_id: 会话 ID
    
    Returns:
        JWT token 字符串
    """
    payload = {
        "role": "admin",
        "session_id": session_id
    }
    return create_jwt(payload, timedelta(days=1))


def create_user_jwt(session_id: str, phrase_id: str, valid_until: datetime) -> str:
    """
    创建用户 JWT（与分享短语同期）
    
    Args:
        session_id: 会话 ID
        phrase_id: 分享短语 ID
        valid_until: 过期时间
    
    Returns:
        JWT token 字符串
    """
    payload = {
        "role": "user",
        "session_id": session_id,
        "phrase_id": phrase_id
    }
    # 计算到 valid_until 的时间差
    expires_delta = valid_until - datetime.now(timezone.utc)
    if expires_delta.total_seconds() <= 0:
        expires_delta = timedelta(seconds=1)  # 最少 1 秒
    return create_jwt(payload, expires_delta)


def get_session_from_request(request: Request) -> Optional[Dict[str, Any]]:
    """
    从请求中提取并验证 JWT，返回会话信息
    支持从 Authorization header 读取
    
    Args:
        request: FastAPI Request 对象
    
    Returns:
        包含 role 和 session_id 的字典，无效返回 None
    """
    # 从 Authorization header 读取: "Bearer <token>"
    auth_header = request.headers.get(JWT_HEADER_NAME)
    if not auth_header:
        return None
    
    # 解析 Bearer token
    parts = auth_header.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    
    token = parts[1]
    payload = decode_jwt(token)
    if not payload:
        return None
    
    # 确保必要字段存在
    if "session_id" not in payload or "role" not in payload:
        return None
    
    return {
        "role": payload["role"],
        "session_id": payload["session_id"],
        "phrase_id": payload.get("phrase_id")
    }


def require_session(request: Request) -> Dict[str, Any]:
    """
    要求请求必须包含有效的会话 JWT
    
    Args:
        request: FastAPI Request 对象
    
    Returns:
        会话信息字典
    
    Raises:
        HTTPException: 401 如果没有有效的 JWT
    """
    session_info = get_session_from_request(request)
    if not session_info:
        raise HTTPException(status_code=401, detail="未认证或会话已过期")
    return session_info
