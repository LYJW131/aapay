"""
管理员路由模块
提供会话管理和分享短语管理的 API 端点
"""

from fastapi import APIRouter, HTTPException, Response, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional
from datetime import datetime, timezone
from uuid import uuid4
import asyncio
import json
import re

from admin_database import get_admin_db, get_session_db_path, delete_session_db
from auth import create_admin_jwt, create_user_jwt
from database import init_db

router = APIRouter(prefix="/admin", tags=["admin"])


# ==================== Admin SSE Setup ====================

# 管理员客户端队列（所有管理员共享）
admin_clients: List[asyncio.Queue] = []


async def broadcast_admin_event(
    event_type: str,
    data: dict = None
):
    """广播事件到所有管理员客户端
    
    Args:
        event_type: 事件类型 (SESSION_CREATED, SESSION_DELETED, PHRASE_CREATED, PHRASE_DELETED)
        data: 附加数据
    """
    payload = {
        "type": event_type,
        "data": data
    }
    message_str = json.dumps(payload, ensure_ascii=False)
    
    disconnected_clients = []
    
    for client in admin_clients:
        try:
            await client.put(message_str)
        except:
            disconnected_clients.append(client)
    
    for client in disconnected_clients:
        if client in admin_clients:
            admin_clients.remove(client)


# ==================== Pydantic Models ====================

class SessionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=10)


class SessionResponse(BaseModel):
    id: str
    name: str
    created_at: str


class PhraseCreate(BaseModel):
    phrase: str = Field(..., min_length=3, max_length=16)
    valid_from: str  # ISO 格式时间字符串
    valid_until: str  # ISO 格式时间字符串
    
    @field_validator('phrase')
    @classmethod
    def validate_phrase(cls, v):
        if not re.match(r'^[a-zA-Z0-9]+$', v):
            raise ValueError('分享短语只能包含大小写字母和数字')
        return v


class PhraseResponse(BaseModel):
    id: str
    session_id: str
    phrase: str
    valid_from: str
    valid_until: str
    created_at: str


# ==================== Admin Auth ====================

@router.get("/auth")
def admin_auth():
    """
    管理员认证检查端点
    实际部署时由 OAuth2 代理保护，这里固定返回 200
    """
    return {"status": "authenticated"}


# ==================== Admin SSE Endpoint ====================

@router.get("/events")
async def admin_sse_endpoint(request: Request):
    """管理员 SSE 端点，用于跨设备同步管理员操作
    
    注意：此端点不需要 JWT 验证，因为 /admin 路径由 OAuth2 代理保护
    管理员身份已通过 OAuth2 验证
    """
    
    async def event_generator():
        q = asyncio.Queue()
        admin_clients.append(q)
        try:
            # 立即发送初始心跳
            yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
            
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"data: {data}\n\n"
                except asyncio.TimeoutError:
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
        except Exception as e:
            print(f"Admin SSE Error: {e}")
        finally:
            if q in admin_clients:
                admin_clients.remove(q)
    
    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ==================== Session Management ====================

@router.get("/sessions", response_model=List[SessionResponse])
def get_sessions():
    """获取所有会话列表"""
    with get_admin_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, created_at FROM sessions ORDER BY created_at DESC")
        return [dict(row) for row in cursor.fetchall()]


@router.post("/sessions", response_model=SessionResponse)
async def create_session(session: SessionCreate):
    """创建新会话"""
    session_id = str(uuid4())
    
    with get_admin_db() as conn:
        cursor = conn.cursor()
        
        # 检查名称唯一性
        cursor.execute("SELECT id FROM sessions WHERE name = ?", (session.name,))
        if cursor.fetchone():
            raise HTTPException(status_code=400, detail="会话名称已存在")
        
        created_at = datetime.now().isoformat()
        cursor.execute(
            "INSERT INTO sessions (id, name, created_at) VALUES (?, ?, ?)",
            (session_id, session.name, created_at)
        )
    
    # 初始化会话数据库
    db_path = get_session_db_path(session_id)
    init_db(db_path)
    
    result = {"id": session_id, "name": session.name, "created_at": created_at}
    
    # 广播事件
    await broadcast_admin_event("SESSION_CREATED", {"session": result})
    
    return result


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """删除会话"""
    with get_admin_db() as conn:
        cursor = conn.cursor()
        
        # 检查会话存在
        cursor.execute("SELECT id FROM sessions WHERE id = ?", (session_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="会话不存在")
        
        # 删除会话记录（级联删除分享短语）
        cursor.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    
    # 删除会话数据库文件
    delete_session_db(session_id)
    
    # 广播事件
    await broadcast_admin_event("SESSION_DELETED", {"session_id": session_id})
    
    return {"status": "success"}


@router.post("/sessions/{session_id}/switch")
def switch_session(session_id: str):
    """切换到指定会话，返回管理员 JWT"""
    with get_admin_db() as conn:
        cursor = conn.cursor()
        
        # 检查会话存在
        cursor.execute("SELECT id FROM sessions WHERE id = ?", (session_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="会话不存在")
    
    # 生成管理员 JWT
    token = create_admin_jwt(session_id)
    
    # 返回 token 而不是设置 Cookie
    return {"status": "success", "session_id": session_id, "token": token}


# ==================== Phrase Management ====================

@router.get("/sessions/{session_id}/phrases", response_model=List[PhraseResponse])
def get_phrases(session_id: str):
    """获取会话的所有分享短语"""
    with get_admin_db() as conn:
        cursor = conn.cursor()
        
        # 检查会话存在
        cursor.execute("SELECT id FROM sessions WHERE id = ?", (session_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="会话不存在")
        
        cursor.execute(
            """SELECT id, session_id, phrase, valid_from, valid_until, created_at 
               FROM share_phrases WHERE session_id = ? ORDER BY created_at DESC""",
            (session_id,)
        )
        return [dict(row) for row in cursor.fetchall()]


@router.post("/sessions/{session_id}/phrases", response_model=PhraseResponse)
async def create_phrase(session_id: str, phrase_data: PhraseCreate):
    """创建分享短语"""
    phrase_id = str(uuid4())
    
    # 解析时间（处理 ISO 8601 的 Z 后缀，表示 UTC 时间）
    try:
        valid_from_str = phrase_data.valid_from.replace('Z', '+00:00')
        valid_until_str = phrase_data.valid_until.replace('Z', '+00:00')
        valid_from = datetime.fromisoformat(valid_from_str)
        valid_until = datetime.fromisoformat(valid_until_str)
        # 如果是 naive datetime，视为 UTC
        if valid_from.tzinfo is None:
            valid_from = valid_from.replace(tzinfo=timezone.utc)
        if valid_until.tzinfo is None:
            valid_until = valid_until.replace(tzinfo=timezone.utc)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"无效的时间格式，请使用 ISO 格式: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"时间解析错误: {str(e)}")
    
    if valid_until <= valid_from:
        raise HTTPException(status_code=400, detail="结束时间必须晚于开始时间")
    
    try:
        with get_admin_db() as conn:
            cursor = conn.cursor()
            
            # 检查会话存在
            cursor.execute("SELECT id FROM sessions WHERE id = ?", (session_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="会话不存在")
            
            now = datetime.now(timezone.utc).isoformat()
            
            # 删除同名的已过期短语
            cursor.execute(
                "DELETE FROM share_phrases WHERE phrase = ? AND valid_until <= ?",
                (phrase_data.phrase, now)
            )
            
            # 检查短语是否还在使用中（未过期的）
            cursor.execute(
                "SELECT id FROM share_phrases WHERE phrase = ? AND valid_until > ?",
                (phrase_data.phrase, now)
            )
            if cursor.fetchone():
                raise HTTPException(status_code=400, detail="该分享短语正在使用中，请等待其过期或使用其他短语")
            
            # 生成用户 JWT
            try:
                jwt_token = create_user_jwt(session_id, phrase_id, valid_until)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"JWT 创建失败: {str(e)}")
            
            created_at = datetime.now().isoformat()
            cursor.execute(
                """INSERT INTO share_phrases 
                   (id, session_id, phrase, jwt_token, valid_from, valid_until, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (phrase_id, session_id, phrase_data.phrase, jwt_token, 
                 phrase_data.valid_from, phrase_data.valid_until, created_at)
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"数据库操作失败: {str(e)}")
    
    result = {
        "id": phrase_id,
        "session_id": session_id,
        "phrase": phrase_data.phrase,
        "valid_from": phrase_data.valid_from,
        "valid_until": phrase_data.valid_until,
        "created_at": created_at
    }
    
    # 广播事件
    await broadcast_admin_event("PHRASE_CREATED", {"phrase": result, "session_id": session_id})
    
    return result


@router.delete("/phrases/{phrase_id}")
async def delete_phrase(phrase_id: str):
    """删除分享短语"""
    session_id = None
    with get_admin_db() as conn:
        cursor = conn.cursor()
        
        cursor.execute("SELECT id, session_id FROM share_phrases WHERE id = ?", (phrase_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="分享短语不存在")
        session_id = row["session_id"]
        
        cursor.execute("DELETE FROM share_phrases WHERE id = ?", (phrase_id,))
    
    # 广播事件
    await broadcast_admin_event("PHRASE_DELETED", {"phrase_id": phrase_id, "session_id": session_id})
    
    return {"status": "success"}
