from fastapi import FastAPI, HTTPException, Request, Response, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Dict
from datetime import datetime, timezone
from collections import defaultdict
import asyncio
import json

import models
from logic import get_store
from auth import require_session, get_session_from_request
from admin_database import get_admin_db
from admin_routes import router as admin_router

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # 使用 Authorization header 不需要 credentials
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册管理员路由
app.include_router(admin_router)


# ==================== SSE Setup (按会话隔离) ====================

# 按会话 ID 存储客户端队列
session_clients: Dict[str, List[asyncio.Queue]] = defaultdict(list)


async def broadcast_event(
    session_id: str, 
    event_type: str, 
    action: str = None, 
    message: str = None, 
    data: dict = None
):
    """广播事件到指定会话的所有客户端
    
    Args:
        session_id: 会话 ID
        event_type: 事件类型 (USER_UPDATE, EXPENSE_UPDATE, SESSION_DELETED)
        action: 具体动作 (add, delete, update)
        message: 通知消息内容
        data: 附加数据
    """
    payload = {
        "type": event_type,
        "action": action,
        "message": message,
        "data": data
    }
    message_str = json.dumps(payload, ensure_ascii=False)
    
    clients = session_clients.get(session_id, [])
    disconnected_clients = []
    
    for client in clients:
        try:
            await client.put(message_str)
        except:
            disconnected_clients.append(client)
    
    for client in disconnected_clients:
        if client in session_clients[session_id]:
            session_clients[session_id].remove(client)


async def broadcast_session_deleted(session_id: str):
    """通知会话被删除"""
    await broadcast_event(
        session_id,
        "SESSION_DELETED",
        action="session_deleted",
        message="当前会话已被删除"
    )


@app.get("/api/events")
async def sse_endpoint(request: Request):
    """SSE 端点，按会话隔离"""
    session_info = get_session_from_request(request)
    if not session_info:
        raise HTTPException(status_code=401, detail="未认证或会话已过期")
    
    session_id = session_info["session_id"]
    
    async def event_generator():
        q = asyncio.Queue()
        session_clients[session_id].append(q)
        try:
            # 立即发送初始心跳，让前端知道连接已建立
            yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
            
            while True:
                if await request.is_disconnected():
                    break
                # Heartbeat every 15s or wait for event
                try:
                    data = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"data: {data}\n\n"
                except asyncio.TimeoutError:
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
        except Exception as e:
            print(f"SSE Error: {e}")
        finally:
            if q in session_clients[session_id]:
                session_clients[session_id].remove(q)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ==================== Auth Exchange ====================

class PhraseExchange(BaseModel):
    phrase: str


@app.post("/auth/exchange")
def exchange_phrase(phrase_data: PhraseExchange):
    """用分享短语换取 JWT"""
    now = datetime.now(timezone.utc).isoformat()
    
    with get_admin_db() as conn:
        cursor = conn.cursor()
        
        # 查找有效的分享短语
        cursor.execute(
            """SELECT id, session_id, jwt_token, valid_from, valid_until 
               FROM share_phrases 
               WHERE phrase = ? AND valid_from <= ? AND valid_until > ?""",
            (phrase_data.phrase, now, now)
        )
        result = cursor.fetchone()
        
        if not result:
            raise HTTPException(status_code=401, detail="无效或已过期的分享短语")
        
        # 检查会话是否还存在
        cursor.execute("SELECT id FROM sessions WHERE id = ?", (result["session_id"],))
        if not cursor.fetchone():
            raise HTTPException(status_code=401, detail="会话已被删除")
        
        jwt_token = result["jwt_token"]
        
        # 返回 token 而不是设置 Cookie
        return {"status": "success", "session_id": result["session_id"], "token": jwt_token}


@app.get("/auth/check")
def check_auth(request: Request):
    """检查当前认证状态"""
    session_info = get_session_from_request(request)
    if not session_info:
        raise HTTPException(status_code=401, detail="未认证或会话已过期")
    
    # 检查会话是否还存在
    with get_admin_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sessions WHERE id = ?", (session_info["session_id"],))
        session = cursor.fetchone()
        if not session:
            raise HTTPException(status_code=401, detail="会话已被删除")
        
        return {
            "authenticated": True,
            "role": session_info["role"],
            "session_id": session_info["session_id"],
            "session_name": session["name"]
        }


# ==================== User Routes (需要认证) ====================

@app.get("/api/users", response_model=List[models.UserResponse])
def get_users(request: Request):
    session_info = require_session(request)
    store = get_store(session_info["session_id"])
    return store.get_users()


@app.post("/api/users", response_model=models.UserResponse)
async def create_user(user: models.UserCreate, request: Request):
    session_info = require_session(request)
    store = get_store(session_info["session_id"])
    
    try:
        new_user = store.add_user(user.name, user.avatar)
        await broadcast_event(
            session_info["session_id"],
            "USER_UPDATE", 
            action="user_add",
            message=f"新成员 {user.name} 加入了"
        )
        return new_user
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/users/{user_id}")
async def delete_user(user_id: str, request: Request):
    session_info = require_session(request)
    store = get_store(session_info["session_id"])
    
    try:
        # 获取用户名用于通知
        user = next((u for u in store.get_users() if u["id"] == user_id), None)
        user_name = user["name"] if user else "未知用户"
        
        store.delete_user(user_id)
        await broadcast_event(
            session_info["session_id"],
            "USER_UPDATE",
            action="user_delete", 
            message=f"成员 {user_name} 已被移除"
        )
        return {"status": "success"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/users/{user_id}", response_model=models.UserResponse)
async def update_user(user_id: str, user_update: models.UserCreate, request: Request):
    session_info = require_session(request)
    store = get_store(session_info["session_id"])
    
    try:
        updated_user = store.update_user(user_id, user_update.name, user_update.avatar)
        await broadcast_event(
            session_info["session_id"],
            "USER_UPDATE",
            action="user_update",
            message=f"成员 {user_update.name} 信息已更新"
        )
        return updated_user
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ==================== Expense Routes (需要认证) ====================

@app.get("/api/expenses", response_model=List[models.ExpenseResponse])
def get_expenses(request: Request, date: str = None):
    session_info = require_session(request)
    store = get_store(session_info["session_id"])
    return store.get_expenses(date)


@app.post("/api/expenses", response_model=models.ExpenseResponse)
async def create_expense(expense: models.ExpenseCreate, request: Request):
    session_info = require_session(request)
    store = get_store(session_info["session_id"])
    
    try:
        # 获取付款人名字
        payer = next((u for u in store.get_users() if u["id"] == expense.payer_id), None)
        payer_name = payer["name"] if payer else "未知"
        
        new_expense = store.add_expense(
            expense.description,
            expense.payer_id,
            expense.amount,
            expense.date,
            expense.participants,
            expense.split_method
        )
        await broadcast_event(
            session_info["session_id"],
            "EXPENSE_UPDATE",
            action="expense_add",
            message=f"{payer_name} 支付了 ¥{expense.amount:.2f} ({expense.description})"
        )
        return new_expense
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/expenses/{expense_id}")
async def delete_expense(expense_id: str, request: Request):
    session_info = require_session(request)
    store = get_store(session_info["session_id"])
    
    try:
        # 获取支出信息用于通知
        expense = next((e for e in store.get_expenses() if e["id"] == expense_id), None)
        desc = expense["description"] if expense else "一笔支出"
        
        store.delete_expense(expense_id)
        await broadcast_event(
            session_info["session_id"],
            "EXPENSE_UPDATE",
            action="expense_delete",
            message=f"已删除: {desc}"
        )
        return {"status": "success"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ==================== Debt Routes (需要认证) ====================

@app.get("/api/debts")
def get_debts(request: Request):
    session_info = require_session(request)
    store = get_store(session_info["session_id"])
    
    transfers = store.calculate_debts()
    # Enrich with names
    users = {u["id"]: u["name"] for u in store.get_users()}
    result = []
    for t in transfers:
        result.append({
            "from_user": users.get(t["from"], "Unknown"),
            "to_user": users.get(t["to"], "Unknown"),
            "amount": t["amount"]
        })
    return result


@app.get("/api/summary")
def get_summary(request: Request):
    session_info = require_session(request)
    store = get_store(session_info["session_id"])
    return store.get_daily_summary()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

