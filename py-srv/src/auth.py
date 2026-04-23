
import os
import sys
import json
import logging
from functools import wraps
from dotenv import load_dotenv
from cfenv import AppEnv
from sap import xssec
import jwt
from fastapi import HTTPException, Request

# Load environment variables
load_dotenv()

# Get logger (configurato in app.py)
logger = logging.getLogger(__name__)

# Environment setup for Cloud Foundry / XSUAA
try:
    env = AppEnv()
    # Try different service names (CAP typically uses '<app>-uaa')
    xsuaa_service = (
        env.get_service(name='task-chain-utilities-uaa')
        or env.get_service(name='conditional-app-uaa')
        or env.get_service(name='auth')
        or env.get_service(name='task-chain-utilities-xsuaa')
        or env.get_service(name='my-app-xsuaa')
        or env.get_service(label='xsuaa')
    )
    if xsuaa_service:
        xsuaa_service = xsuaa_service.credentials
        logger.info("✅ XSUAA service credentials loaded successfully")
    else:
        raise Exception("No XSUAA service found")
except Exception as e:
    logger.error(f"❌ Failed to load XSUAA service credentials: {e}")
    xsuaa_service = None

def flask_access_validation(required_scope=None):
    """
    Flask decorator for XSUAA token validation with scope checking (synchronous).
    """
    def wrapper(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            from flask import request, jsonify

            # Allow tests (and optionally local dev) to bypass auth.
            # This keeps unit/integration tests focused on route behavior.
            try:
                from flask import current_app

                if getattr(current_app, "testing", False):
                    return f(*args, **kwargs)
            except Exception:
                # If Flask context isn't available, continue with validation.
                pass

            # Allow local dev to bypass auth explicitly.
            if os.environ.get("SKIP_AUTH", "false").lower() == "true":
                return f(*args, **kwargs)

            auth_header = request.headers.get('Authorization')
            if not auth_header or not auth_header.startswith('Bearer '):
                logger.warning('Auth header missing or incorrect')
                return jsonify({'error': 'Missing or invalid Authorization header'}), 401

            token = auth_header[len('Bearer '):]
            try:
                decoded = jwt.decode(token, options={"verify_signature": False})
                logger.debug("=== TOKEN PAYLOAD ===\n" + json.dumps(decoded, indent=2))
            except Exception as e:
                logger.error(f"Unable to decode token: {e}")

            if not xsuaa_service:
                logger.error("XSUAA service not available")
                return jsonify({'error': 'XSUAA service not configured'}), 500

            xsappname = xsuaa_service.get("xsappname")
            scope_tgt = f"{xsappname}.{required_scope}" if required_scope else None
            admin_scope = f"{xsappname}.admin"
            logger.debug(f"Required scope: {scope_tgt}")

            try:
                sec_ctx = xssec.create_security_context(token, xsuaa_service)
                # Admin scope grants access to everything (including "read")
                has_required = not scope_tgt or sec_ctx.check_scope(scope_tgt)
                has_admin = sec_ctx.check_scope(admin_scope)
                
                if not has_required and not has_admin:
                    logger.warning(f"Insufficient scope. Required: {scope_tgt} or {admin_scope}")
                    return jsonify({'error': f'Insufficient scope, required {scope_tgt}'}), 403
            except Exception as e:
                logger.exception("Token validation error")
                return jsonify({'error': f'Token validation failed: {str(e)}'}), 403

            return f(*args, **kwargs)
        return decorated
    return wrapper

def access_validation(required_scope=None):
    """
    FastAPI decorator for XSUAA token validation with scope checking.
    Equivalent to the Flask version from old_Server.py
    """
    def wrapper(f):
        @wraps(f)
        async def decorated(request: Request, *args, **kwargs):
            auth_header = request.headers.get('Authorization')
            if not auth_header or not auth_header.startswith('Bearer '):
                logger.warning('Auth header missing or incorrect')
                raise HTTPException(
                    status_code=401,
                    detail='Missing or invalid Authorization header'
                )

            token = auth_header[len('Bearer '):]

            # Debug token payload (without signature verification)
            try:
                decoded = jwt.decode(token, options={"verify_signature": False})
                logger.debug("=== TOKEN PAYLOAD ===\n" + json.dumps(decoded, indent=2))
            except Exception as e:
                logger.error(f"Unable to decode token: {e}")

            if not xsuaa_service:
                logger.error("XSUAA service not available")

                raise HTTPException(
                    status_code=500,
                    detail='XSUAA service not configured'
                )

            xsappname = xsuaa_service.get("xsappname")
            scope_tgt = f"{xsappname}.{required_scope}" if required_scope else None
            logger.debug(f"Required scope: {scope_tgt}")

            try:
                sec_ctx = xssec.create_security_context(token, xsuaa_service)
                if scope_tgt and not sec_ctx.check_scope(scope_tgt):
                    logger.warning(f"Insufficient scope. Required: {scope_tgt}")
                    raise HTTPException(
                        status_code=403,
                        detail=f'Insufficient scope, required {scope_tgt}'
                    )
            except Exception as e:
                logger.exception("Token validation error")
                raise HTTPException(
                    status_code=403,
                    detail=f'Token validation failed: {str(e)}'
                )

            # Call the original function if validation passes
            if hasattr(f, '__code__') and 'request' in f.__code__.co_varnames:
                return await f(request, *args, **kwargs)
            else:
                return await f(*args, **kwargs)
        
        return decorated
    return wrapper

def authenticate_request(request: Request, required_scope="User"):
    """
    Standalone authentication function for backward compatibility.
    This replaces the old Basic Auth method.
    """
    auth_header = request.headers.get('Authorization')
    if not auth_header or not auth_header.startswith('Bearer '):
        logger.warning('Auth header missing or incorrect')
        raise HTTPException(
            status_code=401,
            detail='Missing or invalid Authorization header'
        )

    token = auth_header[len('Bearer '):]

    # Debug token payload (without signature verification)
    try:
        decoded = jwt.decode(token, options={"verify_signature": False})
        logger.debug("=== TOKEN PAYLOAD ===\n" + json.dumps(decoded, indent=2))
    except Exception as e:
        logger.error(f"Unable to decode token: {e}")

    if not xsuaa_service:
        logger.error("XSUAA service not available")
        raise HTTPException(
            status_code=500,
            detail='XSUAA service not configured'
        )

    xsappname = xsuaa_service.get("xsappname")
    scope_tgt = f"{xsappname}.{required_scope}" if required_scope else None
    logger.debug(f"Required scope: {scope_tgt}")

    try:
        sec_ctx = xssec.create_security_context(token, xsuaa_service)
        if scope_tgt and not sec_ctx.check_scope(scope_tgt):
            logger.warning(f"Insufficient scope. Required: {scope_tgt}")
            raise HTTPException(
                status_code=403,
                detail=f'Insufficient scope, required {scope_tgt}'
            )
        logger.info("Token validation successful")
    except Exception as e:
        logger.exception("Token validation error")
        raise HTTPException(
            status_code=403,
            detail=f'Token validation failed: {str(e)}'
        )