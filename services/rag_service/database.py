"""
Database Connectivity Abstraction — Phase 5E Hardening
services/rag_service/database.py

Unified database layer supporting:
  - SQLite for local development and offline test harnesses
  - PostgreSQL for production environments
  - Environment-driven configuration consistent with the repository architecture:
      DATABASE_PROVIDER (default: "sqlite", or "postgresql")
      DATABASE_URL      (e.g., "file:./prisma/dev.db" or "postgresql://user:pass@host:5432/medsync")
      SQLITE_DB_PATH    (e.g., "./prisma/dev.db")
  - Zero hardcoding of database file paths in production logic
  - Identical security predicates and temporal retrieval queries across backends:
      d.patientUid = ? / %s
      d.status = 'approved'
      dcf.version = d.derivativeVersion
"""

import logging
import os
import re
import sqlite3
from typing import Any, Dict, List, Optional, Tuple, Union
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Repository root discovery
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_SQLITE_REL_PATH = os.path.join("prisma", "dev.db")


def get_default_sqlite_path() -> str:
    """Return absolute path to repo's default SQLite database."""
    return os.path.join(_REPO_ROOT, DEFAULT_SQLITE_REL_PATH)


def parse_database_config(
    provider_override: Optional[str] = None,
    url_override: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Resolve database configuration from environment and overrides.

    Precedence:
      1. Explicit overrides passed as arguments
      2. Environment variables: DATABASE_PROVIDER, DATABASE_URL, SQLITE_DB_PATH
      3. Fallback to SQLite with repo-root dev.db
    """
    raw_url = (url_override or os.environ.get("DATABASE_URL", "")).strip()
    raw_provider = (provider_override or os.environ.get("DATABASE_PROVIDER", "")).strip().lower()
    sqlite_env_path = os.environ.get("SQLITE_DB_PATH", "").strip()

    # Deduce provider if not explicitly specified
    if not raw_provider:
        if raw_url.startswith("postgres://") or raw_url.startswith("postgresql://"):
            provider = "postgresql"
        else:
            provider = "sqlite"
    else:
        provider = raw_provider

    if provider in ("postgres", "postgresql", "pg"):
        canonical_provider = "postgresql"
        # Validate connection URL format
        if raw_url and not (raw_url.startswith("postgres://") or raw_url.startswith("postgresql://")):
            raise ValueError(
                f"INVALID_DATABASE_URL: PostgreSQL provider requires a postgresql:// or postgres:// URL, got: {raw_url[:15]}..."
            )
        connection_url = raw_url
        sqlite_file_path = None
    elif provider in ("sqlite", "sqlite3"):
        canonical_provider = "sqlite"
        if url_override and not url_override.startswith("file:"):
            # Direct file path passed as override
            sqlite_file_path = os.path.abspath(url_override)
        elif raw_url.startswith("file:"):
            file_part = raw_url[5:]
            if os.path.isabs(file_part):
                sqlite_file_path = file_part
            else:
                sqlite_file_path = os.path.abspath(os.path.join(_REPO_ROOT, file_part))
        elif sqlite_env_path:
            if os.path.isabs(sqlite_env_path):
                sqlite_file_path = sqlite_env_path
            else:
                sqlite_file_path = os.path.abspath(os.path.join(_REPO_ROOT, sqlite_env_path))
        elif url_override:
            sqlite_file_path = os.path.abspath(url_override)
        else:
            sqlite_file_path = get_default_sqlite_path()

        connection_url = f"file:{sqlite_file_path}"
    else:
        raise ValueError(f"UNSUPPORTED_DATABASE_PROVIDER: Provider '{provider}' is not supported. Use 'sqlite' or 'postgresql'.")

    return {
        "provider": canonical_provider,
        "url": connection_url,
        "sqlite_path": sqlite_file_path,
        "is_sqlite": canonical_provider == "sqlite",
        "is_postgresql": canonical_provider == "postgresql",
    }


class DatabaseClient:
    """
    Unified database client abstraction for Phase 5E RAG services.
    Enforces identical security predicates across SQLite and PostgreSQL:
      - patientUid scope isolation
      - status = 'approved' gate
      - derivativeVersion == approvedVersion gate
    """

    def __init__(
        self,
        provider: Optional[str] = None,
        database_url: Optional[str] = None,
    ):
        self.config = parse_database_config(provider_override=provider, url_override=database_url)
        self.provider = self.config["provider"]
        self.sqlite_path = self.config["sqlite_path"]
        self.url = self.config["url"]

    def is_available(self) -> bool:
        """Check if the configured database backend is reachable/accessible."""
        if self.config["is_sqlite"]:
            return bool(self.sqlite_path and os.path.isfile(self.sqlite_path))
        elif self.config["is_postgresql"]:
            # Validate URL structure and driver availability
            if not self.url:
                return False
            try:
                # If sqlalchemy is available, try a fast connection check
                from sqlalchemy import create_engine, text
                engine = create_engine(self.url, connect_args={"connect_timeout": 2})
                with engine.connect() as conn:
                    conn.execute(text("SELECT 1"))
                return True
            except Exception:
                return False
        return False

    def fetch_temporal_facts(self, patient_uid: str) -> List[Dict[str, Any]]:
        """
        Execute Path B temporal retrieval query.

        Canonical SQL Query:
          SELECT dcf.id, dcf.documentId, dcf.pageNumber, dcf.factType,
                 dcf.factKey, dcf.factValue, dcf.unit, dcf.clinicalDate,
                 dcf.confidence, dcf.provenance, dcf.version,
                 d.derivativeVersion, d.clinicalDate AS docClinicalDate,
                 d.documentType
          FROM DocumentClinicalFact dcf
          JOIN Document d ON dcf.documentId = d.documentId
          WHERE d.patientUid = :patient_uid
            AND d.status = 'approved'
            AND dcf.version = d.derivativeVersion
          ORDER BY dcf.clinicalDate ASC, dcf.id ASC
        """
        if self.config["is_sqlite"]:
            return self._fetch_temporal_facts_sqlite(patient_uid)
        elif self.config["is_postgresql"]:
            return self._fetch_temporal_facts_postgres(patient_uid)
        return []

    def _fetch_temporal_facts_sqlite(self, patient_uid: str) -> List[Dict[str, Any]]:
        if not self.sqlite_path or not os.path.isfile(self.sqlite_path):
            logger.debug(f"SQLite file not found at: {self.sqlite_path}")
            return []

        query = """
            SELECT
                dcf.id,
                dcf.documentId,
                dcf.pageNumber,
                dcf.factType,
                dcf.factKey,
                dcf.factValue,
                dcf.unit,
                dcf.clinicalDate,
                dcf.confidence,
                dcf.provenance,
                dcf.version,
                d.derivativeVersion,
                d.clinicalDate AS docClinicalDate,
                d.documentType
            FROM DocumentClinicalFact dcf
            JOIN Document d ON dcf.documentId = d.documentId
            WHERE d.patientUid = ?
              AND d.status = 'approved'
              AND dcf.version = d.derivativeVersion
            ORDER BY dcf.clinicalDate ASC, dcf.id ASC
        """
        con = sqlite3.connect(self.sqlite_path)
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute(query, (patient_uid,)).fetchall()
            return [dict(r) for r in rows]
        finally:
            con.close()

    def _fetch_temporal_facts_postgres(self, patient_uid: str) -> List[Dict[str, Any]]:
        query = """
            SELECT
                dcf."id",
                dcf."documentId",
                dcf."pageNumber",
                dcf."factType",
                dcf."factKey",
                dcf."factValue",
                dcf."unit",
                dcf."clinicalDate",
                dcf."confidence",
                dcf."provenance",
                dcf."version",
                d."derivativeVersion",
                d."clinicalDate" AS "docClinicalDate",
                d."documentType"
            FROM "DocumentClinicalFact" dcf
            JOIN "Document" d ON dcf."documentId" = d."documentId"
            WHERE d."patientUid" = :patient_uid
              AND d."status" = 'approved'
              AND dcf."version" = d."derivativeVersion"
            ORDER BY dcf."clinicalDate" ASC, dcf."id" ASC
        """
        try:
            from sqlalchemy import create_engine, text
            engine = create_engine(self.url, pool_pre_ping=True)
            with engine.connect() as conn:
                result = conn.execute(text(query), {"patient_uid": patient_uid})
                return [dict(row._mapping) for row in result]
        except Exception as exc:
            logger.warning(f"PostgreSQL query execution error: {exc}")
            return []


# ── Global Default Client ───────────────────────────────────────────────────
_global_client: Optional[DatabaseClient] = None


def get_database_client(
    provider_override: Optional[str] = None,
    url_override: Optional[str] = None,
) -> DatabaseClient:
    """Singleton getter or customized client constructor."""
    global _global_client
    if provider_override or url_override:
        return DatabaseClient(provider=provider_override, database_url=url_override)
    if _global_client is None:
        _global_client = DatabaseClient()
    return _global_client
