from pydantic import BaseModel
from typing import List, Optional

class UserCreate(BaseModel):
    name: str
    avatar: Optional[str] = None

class UserResponse(BaseModel):
    id: str
    name: str
    avatar: str

class ExpenseCreate(BaseModel):
    description: str
    payer_id: str
    amount: float
    date: str
    participants: List[str]
    split_method: str = "average"

class ExpenseResponse(BaseModel):
    id: str
    description: str
    payer_id: str
    amount: float
    date: str
    participants: List[str]
    split_method: str
    created_at: str

class TransferPlan(BaseModel):
    from_user: str
    to_user: str
    amount: float
