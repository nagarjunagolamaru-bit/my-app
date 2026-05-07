from pydantic import BaseModel


class LoginRequest(BaseModel):
    email: str
    password: str


class GoogleAuthRequest(BaseModel):
    id_token: str


class UserRead(BaseModel):
    id: int
    email: str

    class Config:
        from_attributes = True


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = 'bearer'
    user: UserRead
