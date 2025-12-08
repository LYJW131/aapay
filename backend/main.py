from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from typing import List
import asyncio
import json
import logic
import models

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# SSE Setup
clients = []

async def broadcast_event(event_type: str, action: str = None, message: str = None, data: dict = None):
    """广播事件到所有客户端
    
    Args:
        event_type: 事件类型 (USER_UPDATE, EXPENSE_UPDATE)
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
    disconnected_clients = []
    for client in clients:
        try:
            await client.put(message_str)
        except:
            disconnected_clients.append(client)
    
    for client in disconnected_clients:
        clients.remove(client)

@app.get("/api/events")
async def sse_endpoint(request: Request):
    async def event_generator():
        q = asyncio.Queue()
        clients.append(q)
        try:
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
            if q in clients:
                clients.remove(q)

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# User Routes
@app.get("/api/users", response_model=List[models.UserResponse])
def get_users():
    return logic.store.get_users()

@app.post("/api/users", response_model=models.UserResponse)
async def create_user(user: models.UserCreate):
    try:
        new_user = logic.store.add_user(user.name, user.avatar)
        await broadcast_event(
            "USER_UPDATE", 
            action="user_add",
            message=f"新成员 {user.name} 加入了"
        )
        return new_user
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.delete("/api/users/{user_id}")
async def delete_user(user_id: str):
    try:
        # 获取用户名用于通知
        user = next((u for u in logic.store.get_users() if u["id"] == user_id), None)
        user_name = user["name"] if user else "未知用户"
        
        logic.store.delete_user(user_id)
        await broadcast_event(
            "USER_UPDATE",
            action="user_delete", 
            message=f"成员 {user_name} 已被移除"
        )
        return {"status": "success"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.put("/api/users/{user_id}", response_model=models.UserResponse)
async def update_user(user_id: str, user_update: models.UserCreate):
    try:
        updated_user = logic.store.update_user(user_id, user_update.name, user_update.avatar)
        await broadcast_event(
            "USER_UPDATE",
            action="user_update",
            message=f"成员 {user_update.name} 信息已更新"
        )
        return updated_user
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# Expense Routes
@app.get("/api/expenses", response_model=List[models.ExpenseResponse])
def get_expenses(date: str = None):
    return logic.store.get_expenses(date)

@app.post("/api/expenses", response_model=models.ExpenseResponse)
async def create_expense(expense: models.ExpenseCreate):
    try:
        # 获取付款人名字
        payer = next((u for u in logic.store.get_users() if u["id"] == expense.payer_id), None)
        payer_name = payer["name"] if payer else "未知"
        
        new_expense = logic.store.add_expense(
            expense.description,
            expense.payer_id,
            expense.amount,
            expense.date,
            expense.participants,
            expense.split_method
        )
        await broadcast_event(
            "EXPENSE_UPDATE",
            action="expense_add",
            message=f"{payer_name} 支付了 ¥{expense.amount:.2f} ({expense.description})"
        )
        return new_expense
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.delete("/api/expenses/{expense_id}")
async def delete_expense(expense_id: str):
    try:
        # 获取支出信息用于通知
        expense = next((e for e in logic.store.get_expenses() if e["id"] == expense_id), None)
        desc = expense["description"] if expense else "一笔支出"
        
        logic.store.delete_expense(expense_id)
        await broadcast_event(
            "EXPENSE_UPDATE",
            action="expense_delete",
            message=f"已删除: {desc}"
        )
        return {"status": "success"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

# Debt Routes
@app.get("/api/debts")
def get_debts():
    transfers = logic.store.calculate_debts()
    # Enrich with names
    users = {u["id"]: u["name"] for u in logic.store.get_users()}
    result = []
    for t in transfers:
        result.append({
            "from_user": users.get(t["from"], "Unknown"),
            "to_user": users.get(t["to"], "Unknown"),
            "amount": t["amount"]
        })
    return result

@app.get("/api/summary")
def get_summary():
    return logic.store.get_daily_summary()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
