"""Meta/system endpoints (root + health + docs)."""

from __future__ import annotations

from flask import Blueprint, Response, current_app, jsonify, request

from ..config import Config


bp = Blueprint("meta", __name__)


@bp.get("/")
def index():
    """Service root (kept minimal; docs are in /docs)."""
    return jsonify(
        {
            "service": "Taskchain Routing Microservice",
            "version": "1.0.0",
            "docs": "/docs",
            "openapi": "/openapi.json",
        }
    )


@bp.get("/health")
def health():
    """Simple liveness probe."""
    return jsonify({"status": "healthy"})


@bp.get("/status")
def status():
    """Full health including repository/DSP components."""
    try:
        routing_service = current_app.extensions["taskchain"]["routing_service"]
        db_query_executor = current_app.extensions["taskchain"]["db_query_executor"]

        health_status = routing_service.check_status()
        return jsonify(health_status), (200 if health_status.get("status") == "ok" else 503)
    except Exception as e:
        return (
            jsonify({"status": "degraded", "components": {"db": "error"}, "error": str(e)}),
            503,
        )


def _openapi_spec() -> dict:
    # Respect reverse-proxy headers (approuter) so Swagger uses https.
    proto = request.headers.get("X-Forwarded-Proto", request.scheme)
    host = request.headers.get("X-Forwarded-Host", request.host)

    # If headers contain multiple values, keep the first one.
    if "," in proto:
        proto = proto.split(",", 1)[0].strip()
    if "," in host:
        host = host.split(",", 1)[0].strip()

    server_url = f"{proto}://{host}".rstrip("/")
    app = current_app

    def rule_to_openapi_path(rule_obj) -> str:
        # Flask uses <param> or <converter:param>; OpenAPI uses {param}
        out = rule_obj.rule

        # Fast path for common case with plain <param>
        for arg in sorted(getattr(rule_obj, "arguments", []) or []):
            out = out.replace(f"<{arg}>", f"{{{arg}}}")

        # Best-effort handling for converters like <int:id> -> {id}
        while "<" in out and ">" in out:
            start = out.find("<")
            end = out.find(">", start)
            if end == -1:
                break
            segment = out[start + 1 : end]
            name = segment.split(":", 1)[-1]
            out = out[:start] + "{" + name + "}" + out[end + 1 :]

        return out

    def view_summary(endpoint: str) -> str:
        fn = app.view_functions.get(endpoint)
        doc = (getattr(fn, "__doc__", None) or "").strip()
        if doc:
            return doc.splitlines()[0].strip()
        return endpoint

    paths: dict = {}
    for rule in app.url_map.iter_rules():
        if rule.endpoint == "static":
            continue

        # Avoid documenting docs endpoints themselves to reduce recursion/noise.
        if rule.rule in ("/docs", "/openapi.json"):
            continue

        openapi_path = rule_to_openapi_path(rule)
        methods = sorted((rule.methods or set()) - {"HEAD", "OPTIONS"})
        if not methods:
            continue

        # Endpoint format is typically '<blueprint>.<function>'
        tag = rule.endpoint.split(".", 1)[0] if "." in rule.endpoint else "default"
        item = paths.setdefault(openapi_path, {})

        for m in methods:
            op: dict = {
                "tags": [tag],
                "summary": view_summary(rule.endpoint),
                "operationId": f"{rule.endpoint}__{m.lower()}",
                "responses": {"200": {"description": "OK"}},
            }

            # Path parameters
            if rule.arguments:
                op["parameters"] = [
                    {
                        "name": arg,
                        "in": "path",
                        "required": True,
                        "schema": {"type": "string"},
                    }
                    for arg in sorted(rule.arguments)
                ]

            # Generic JSON body for write-ish methods
            if m in {"POST", "PUT", "PATCH"}:
                op["requestBody"] = {
                    "required": True,
                    "content": {"application/json": {"schema": {"type": "object"}}},
                }

            # Apply bearer auth by default to everything except public meta endpoints.
            if rule.rule not in ("/", "/health", "/status"):
                op["security"] = [{"bearerAuth": []}]

            item[m.lower()] = op

    return {
        "openapi": "3.0.3",
        "info": {
            "title": "Taskchain Routing Microservice",
            "version": "1.0.0",
            "description": "Routing + validation + read-only DB query endpoints for task-chain-utilities.",
        },
        "servers": [{"url": server_url}],
        "components": {
            "securitySchemes": {
                "bearerAuth": {
                    "type": "http",
                    "scheme": "bearer",
                    "bearerFormat": "JWT",
                }
            }
        },
        "paths": paths,
    }


@bp.get("/openapi.json")
def openapi_json():
    return jsonify(_openapi_spec())


@bp.get("/docs")
def docs():
    """Swagger UI backed by /openapi.json (no extra server deps)."""
    html = """<!doctype html>
<html>
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>API Docs</title>
    <link rel=\"stylesheet\" href=\"https://unpkg.com/swagger-ui-dist@5/swagger-ui.css\" />
    <style>body { margin: 0; }</style>
  </head>
  <body>
    <div id=\"swagger-ui\"></div>
    <script src=\"https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js\"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout'
      });
    </script>
  </body>
</html>"""
    return Response(html, mimetype="text/html")
