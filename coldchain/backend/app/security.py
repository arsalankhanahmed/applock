"""Password hashing, dashboard JWTs and device credentials (standard library only, plus PyJWT)."""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import timedelta

import jwt
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import Device, User, get_db, utcnow

_PBKDF2_ROUNDS = 240_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), _PBKDF2_ROUNDS).hex()
    return f"pbkdf2_sha256${_PBKDF2_ROUNDS}${salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, rounds, salt, digest = stored.split("$")
    except ValueError:
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds)).hex()
    return hmac.compare_digest(candidate, digest)


def create_token(user: User) -> str:
    payload = {"sub": str(user.id), "role": user.role,
               "exp": utcnow() + timedelta(minutes=settings.JWT_EXPIRE_MINUTES)}
    return jwt.encode(payload, settings.JWT_SECRET, algorithm="HS256")


def current_user(authorization: str = Header(default=""), db: Session = Depends(get_db)) -> User:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired, sign in again")
    user = db.get(User, int(payload.get("sub", 0)))
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    return user


def admin_user(user: User = Depends(current_user)) -> User:
    if user.role != "ADMIN":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only admins can change this")
    return user


# --- Devices ------------------------------------------------------------------------------------------------

def new_device_credentials() -> tuple[str, str]:
    """Return (serial, secret). The serial goes on the label; the secret is shown once and stored hashed."""
    secret = secrets.token_urlsafe(24)
    while secret.startswith("-"):                 # a leading dash reads as an option on command lines
        secret = secrets.token_urlsafe(24)
    return f"CC-{secrets.token_hex(3).upper()}", secret


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def current_device(x_device_serial: str = Header(default=""), x_device_key: str = Header(default=""),
                   db: Session = Depends(get_db)) -> Device:
    device = db.scalars(select(Device).where(Device.serial == x_device_serial)).first() if x_device_serial else None
    if device is None or not hmac.compare_digest(device.secret_hash, hash_secret(x_device_key)):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unknown device or wrong key")
    return device
