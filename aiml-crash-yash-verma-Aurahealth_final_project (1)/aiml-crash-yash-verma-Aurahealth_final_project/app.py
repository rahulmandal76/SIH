import os
import time
import logging
from dotenv import load_dotenv

# Load env before any local module imports
load_dotenv(override=True)

import streamlit as st

from rag_pipeline import RAGPipeline
from loader import Document, extract_text_from_bytes

# Configure logger
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# --- PAGE CONFIGURATION ---
st.set_page_config(
    page_title="AuraHealth Nexus | SYN-PAT-001 Longitudinal Medical RAG",
    page_icon="🧬",
    layout="wide",
    initial_sidebar_state="expanded"
)

# --- CUSTOM DARK THEME CSS ---
st.markdown("""
<style>
    /* Global Background and Text */
    .stApp {
        background: linear-gradient(135deg, #0B0F19 0%, #111827 50%, #0F172A 100%);
        color: #E2E8F0;
        font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
    }
    
    /* Header and Branding Styling */
    .main-title {
        background: linear-gradient(90deg, #00F2FE 0%, #4FACFE 50%, #00C6FF 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        font-size: 2.5rem;
        font-weight: 800;
        letter-spacing: -0.02em;
        margin-bottom: 0.2rem;
    }
    .sub-title {
        color: #94A3B8;
        font-size: 1.05rem;
        font-weight: 400;
        margin-bottom: 1.5rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        padding-bottom: 1rem;
    }
    
    /* Sidebar Styling */
    section[data-testid="stSidebar"] {
        background-color: #0F172A !important;
        border-right: 1px solid rgba(255, 255, 255, 0.08);
    }
    section[data-testid="stSidebar"] h1, section[data-testid="stSidebar"] h2, section[data-testid="stSidebar"] h3 {
        color: #F8FAFC !important;
    }
    
    /* Metric Card Styling */
    div[data-testid="stMetric"] {
        background: rgba(30, 41, 59, 0.5);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        padding: 10px 14px;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        transition: transform 0.2s ease, border-color 0.2s ease;
    }
    div[data-testid="stMetric"]:hover {
        transform: translateY(-2px);
        border-color: #38BDF8;
    }
    div[data-testid="stMetric"] label {
        color: #94A3B8 !important;
        font-size: 0.82rem !important;
        font-weight: 500 !important;
    }
    div[data-testid="stMetric"] div[data-testid="stMetricValue"] {
        color: #38BDF8 !important;
        font-size: 1.25rem !important;
        font-weight: 700 !important;
    }
    
    /* Response Cards and Badges */
    .response-card {
        background: rgba(30, 41, 59, 0.6);
        border: 1px solid rgba(56, 189, 248, 0.25);
        border-radius: 14px;
        padding: 1.2rem;
        margin-top: 0.8rem;
        margin-bottom: 1.2rem;
        box-shadow: 0 8px 25px -5px rgba(0, 242, 254, 0.08);
    }
    
    .badge-high {
        background-color: rgba(16, 185, 129, 0.15);
        color: #34D399;
        border: 1px solid #10B981;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 0.8rem;
        font-weight: 600;
        display: inline-block;
    }
    .badge-medium {
        background-color: rgba(245, 158, 11, 0.15);
        color: #FBBF24;
        border: 1px solid #F59E0B;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 0.8rem;
        font-weight: 600;
        display: inline-block;
    }
    .badge-low {
        background-color: rgba(239, 68, 68, 0.15);
        color: #F87171;
        border: 1px solid #EF4444;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 0.8rem;
        font-weight: 600;
        display: inline-block;
    }
    .badge-info {
        background-color: rgba(56, 189, 248, 0.15);
        color: #38BDF8;
        border: 1px solid #0284C7;
        padding: 4px 10px;
        border-radius: 20px;
        font-size: 0.78rem;
        font-weight: 600;
        display: inline-block;
    }
    
    /* Chat Bubble Tweaks */
    div[data-testid="stChatMessage"] {
        background: rgba(15, 23, 42, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 16px;
        padding: 1rem;
        margin-bottom: 1rem;
    }
    
    /* Expander styling */
    div[data-testid="stExpander"] {
        border: 1px solid rgba(255, 255, 255, 0.1) !important;
        border-radius: 10px !important;
        background: rgba(15, 23, 42, 0.4) !important;
    }
    
    /* Custom buttons */
    div.stButton > button {
        background: linear-gradient(90deg, #0284C7 0%, #0369A1 100%);
        color: white;
        font-weight: 600;
        border: none;
        border-radius: 8px;
        padding: 0.5rem 1rem;
        transition: all 0.2s ease;
    }
    div.stButton > button:hover {
        background: linear-gradient(90deg, #0369A1 0%, #075985 100%);
        box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3);
        transform: translateY(-1px);
    }
</style>
""", unsafe_allow_html=True)

# --- SESSION STATE INITIALIZATION ---
if "pipeline" not in st.session_state:
    with st.spinner("🚀 Initializing AuraHealth Nexus Longitudinal RAG Engine..."):
        pipeline = RAGPipeline(top_k=6)
        try:
            pipeline.index()
        except Exception as e:
            logger.error(f"Error initializing index: {e}")
        st.session_state.pipeline = pipeline

if "chat_history" not in st.session_state:
    st.session_state.chat_history = []

if "last_response_time" not in st.session_state:
    st.session_state.last_response_time = 0.0

if "notification" not in st.session_state:
    st.session_state.notification = None

# --- SIDEBAR: STATISTICS & MANAGEMENT ---
with st.sidebar:
    st.markdown("### 🧬 AuraHealth Nexus")
    st.markdown("*Single-Patient Longitudinal RAG System*")
    st.markdown("---")
    
    # Statistics Dashboard
    st.markdown("#### 📊 Patient & System Stats")
    stats = st.session_state.pipeline.get_stats()
    
    col1, col2 = st.columns(2)
    with col1:
        st.metric(label="Patient ID", value=stats["patient_id"])
    with col2:
        st.metric(label="Time Span", value=stats["years_span"])
        
    col3, col4 = st.columns(2)
    with col3:
        st.metric(label="Yearly Docs", value=stats["indexed_documents"])
    with col4:
        st.metric(label="Total Chunks", value=stats["total_chunks"])
        
    resp_time = f"{st.session_state.last_response_time:.2f}s" if st.session_state.last_response_time > 0 else "--"
    st.metric(label="Last Query Latency", value=resp_time)
        
    st.markdown(f"**🧠 Embedding Model:** `{stats['embedding_model']}`")
    st.markdown(f"**🗄️ Vector Store:** `{stats['vector_store']}`")
    st.markdown(f"**🤖 LLM Engine:** `{stats['llm_model']}`")
    st.markdown("---")
    
    # Document Upload & Ingestion
    st.markdown("#### 📤 Ingest Yearly Records")
    uploaded_files = st.file_uploader(
        "Upload patient records (.txt, .pdf, .docx)",
        type=["txt", "pdf", "docx"],
        accept_multiple_files=True,
        help="Upload new yearly records to automatically extract patient metadata and index into vector store."
    )
    
    if uploaded_files:
        if st.button("⚡ Ingest & Update Patient Index", use_container_width=True):
            data_dir = st.session_state.pipeline.data_dir
            os.makedirs(data_dir, exist_ok=True)
            
            with st.status("🔄 Processing uploaded records...", expanded=True) as status:
                success_count = 0
                for ufile in uploaded_files:
                    try:
                        st.write(f"📖 Reading `{ufile.name}`...")
                        file_bytes = ufile.read()
                        text = extract_text_from_bytes(ufile.name, file_bytes)
                        if not text.strip():
                            st.warning(f"⚠️ `{ufile.name}` is empty or unreadable.")
                            continue
                            
                        save_path = os.path.join(data_dir, ufile.name)
                        with open(save_path, "wb") as f:
                            f.write(file_bytes)
                        success_count += 1
                    except Exception as e:
                        st.error(f"❌ Failed to ingest `{ufile.name}`: {str(e)}")
                        
                if success_count > 0:
                    st.write("🧠 Re-chunking and rebuilding patient FAISS index...")
                    try:
                        st.session_state.pipeline.index(force_rebuild=True)
                        status.update(label=f"✅ Ingested {success_count} record(s) and rebuilt index!", state="complete")
                        st.session_state.notification = ("success", f"Ingested {success_count} file(s) and updated index!")
                        time.sleep(1)
                        st.rerun()
                    except Exception as e:
                        status.update(label=f"❌ Indexing failed: {str(e)}", state="error")
                else:
                    status.update(label="⚠️ No valid files were ingested.", state="error")

    st.markdown("---")
    
    # Action Buttons
    st.markdown("#### ⚙️ System Controls")
    if st.button("🔄 Force Rebuild Patient Index", use_container_width=True):
        with st.spinner("Rebuilding patient vector index from scratch..."):
            try:
                st.session_state.pipeline.index(force_rebuild=True)
                st.success("✅ Patient index rebuilt successfully!")
                time.sleep(1)
                st.rerun()
            except Exception as e:
                st.error(f"Error rebuilding index: {e}")
                
    if st.button("🗑️ Clear Chat History", use_container_width=True):
        st.session_state.pipeline.reset_history()
        st.session_state.chat_history = []
        st.session_state.last_response_time = 0.0
        st.success("💬 Conversation cleared!")
        time.sleep(0.5)
        st.rerun()

    st.markdown("---")
    st.caption("AuraHealth Nexus | Longitudinal Medical RAG v3.0")

# --- MAIN PAGE: HEADER & DESCRIPTION ---
st.markdown('<div class="main-title">🧬 AuraHealth Nexus</div>', unsafe_allow_html=True)
st.markdown('<div class="sub-title"><b>SYN-PAT-001</b> Longitudinal Medical History RAG (2010 – 2024) | <i>Synthetic Clinical Dataset</i></div>', unsafe_allow_html=True)

# Display toast/notification if present
if st.session_state.notification:
    ntype, nmsg = st.session_state.notification
    if ntype == "success":
        st.success(nmsg)
    elif ntype == "error":
        st.error(nmsg)
    st.session_state.notification = None

# --- ERROR HANDLING & ENVIRONMENT WARNINGS ---
groq_key = os.getenv("GROQ_API_KEY")
if not groq_key:
    st.warning("⚠️ **GROQ_API_KEY not detected!** Live generation via Groq API will fail. Please configure `GROQ_API_KEY` in your `.env` file.")

if stats["total_chunks"] == 0:
    st.error(f"🚨 **Vector Store is Empty!** No documents found in `{st.session_state.pipeline.data_dir}`. Please check data directory or rebuild index.")

# --- EMPTY STATE: SUGGESTED DEMO QUERIES ---
demo_query = None
if not st.session_state.chat_history:
    st.markdown("""
    <div style="background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 1.2rem; margin-bottom: 1.5rem;">
        <h4 style="margin-top: 0; color: #38BDF8; font-size: 1.1rem;">💡 Longitudinal Medical Reasoning Demo Queries</h4>
        <p style="color: #94A3B8; font-size: 0.9rem; margin-bottom: 0.8rem;">Click any sample question below to test timeline synthesis, medication history, and lab trends across 15 years:</p>
    </div>
    """, unsafe_allow_html=True)
    
    col_a, col_b = st.columns(2)
    with col_a:
        if st.button("📉 How did kidney function (eGFR) change over time?", use_container_width=True):
            demo_query = "How did eGFR and kidney function change from baseline in 2010 to 2024?"
        if st.button("💊 When was Losartan added and what are the 2024 medications?", use_container_width=True):
            demo_query = "When was losartan added and what medications were documented in 2024?"
    with col_b:
        if st.button("🩺 When did prediabetes progress to Type 2 diabetes?", use_container_width=True):
            demo_query = "When was type 2 diabetes first documented and what was the progression from prediabetes?"
        if st.button("📅 Give a chronological summary of major medical events", use_container_width=True):
            demo_query = "Give a chronological summary of the patient's major medical events from 2010 to 2024."

# --- MAIN CHAT AREA ---
for msg in st.session_state.chat_history:
    role = msg["role"]
    avatar = "👤" if role == "user" else "🧬"
    
    with st.chat_message(role, avatar=avatar):
        st.markdown(msg["content"])
        
        # Render Response Card & Citations for assistant answers
        if role == "assistant" and "metadata" in msg and msg["metadata"]:
            meta = msg["metadata"]
            conf = meta.get("confidence", "Low")
            score = meta.get("top_score", 0.0)
            elapsed = meta.get("time_taken", 0.0)
            sources = meta.get("sources", [])
            years = meta.get("years", [])
            strategy = meta.get("strategy", "STANDARD_SEMANTIC")
            retrieved_chunks = meta.get("retrieved", [])
            tokens = meta.get("total_tokens")
            
            badge_class = f"badge-{conf.lower()}"
            badge_icon = "🟢" if conf == "High" else "🟡" if conf == "Medium" else "🔴"
            token_display = f" | 🔤 Tokens: <b>{tokens}</b>" if tokens else ""
            years_display = f"📅 Years Retrieved: <b>{', '.join(str(y) for y in years)}</b>" if years else "📅 Years: <i>None</i>"
            
            st.markdown(f"""
            <div class="response-card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
                    <div>
                        <span class="{badge_class}">{badge_icon} {conf} Confidence ({score:.1%})</span>
                        <span class="badge-info" style="margin-left: 6px;">🎯 Strategy: {strategy.replace('_', ' ').title()}</span>
                    </div>
                    <span style="color: #94A3B8; font-size: 0.85rem;">⏱️ Latency: <b>{elapsed:.2f}s</b>{token_display}</span>
                </div>
                <div style="font-size: 0.88rem; color: #CBD5E1; margin-bottom: 4px;">
                    {years_display}
                </div>
                <div style="font-size: 0.88rem; color: #94A3B8;">
                    <b>📑 Primary Source Records:</b> {', '.join([f'`{s}`' for s in sources]) if sources else '<i>None retrieved</i>'}
                </div>
            </div>
            """, unsafe_allow_html=True)
            
            # Expandable Source Viewer
            if retrieved_chunks:
                with st.expander(f"🔍 Inspect Chronological Evidence Chunks ({len(retrieved_chunks)} Chunks Retrieved)"):
                    for idx, (chk, sim) in enumerate(retrieved_chunks, 1):
                        yr_str = str(chk.year) if chk.year is not None else "Unknown"
                        st.markdown(f"""
                        **Rank #{idx}** | 📅 **Year:** `{yr_str}` | 📄 **Source:** `{chk.source}` | 🔢 **Chunk ID:** `{chk.id}` | 🎯 **Relevance:** `{sim:.3f}`
                        """)
                        st.code(chk.text, language="markdown")
                        if idx < len(retrieved_chunks):
                            st.divider()

# --- CHAT INPUT & EXECUTION ---
input_query = st.chat_input("Ask about SYN-PAT-001 (e.g., 'How did HbA1c change from 2010 to 2024?')")
active_query = demo_query or input_query

if active_query:
    if stats["total_chunks"] == 0:
        st.error("Please index patient documents before asking questions.")
    else:
        # Render user question immediately
        with st.chat_message("user", avatar="👤"):
            st.markdown(active_query)
        
        st.session_state.chat_history.append({
            "role": "user",
            "content": active_query,
            "timestamp": time.strftime("%H:%M:%S")
        })
        
        with st.chat_message("assistant", avatar="🧬"):
            with st.status("🧠 Analyzing patient longitudinal medical history...", expanded=True) as status:
                try:
                    st.write("🔎 Performing chronological temporal retrieval across patient records...")
                    res = st.session_state.pipeline.ask_with_metadata(active_query, use_history=True)
                    
                    st.write("⚙️ Synthesizing grounded medical response...")
                    time.sleep(0.3)
                    
                    status.update(label="✅ Response synthesized successfully!", state="complete", expanded=False)
                    
                    st.markdown(res["answer"])
                    
                    st.session_state.last_response_time = res["time_taken"]
                    
                    st.session_state.chat_history.append({
                        "role": "assistant",
                        "content": res["answer"],
                        "timestamp": time.strftime("%H:%M:%S"),
                        "metadata": res
                    })
                    
                    st.rerun()
                    
                except Exception as e:
                    logger.error(f"Error during RAG execution: {e}")
                    status.update(label="❌ Error generating response", state="error", expanded=True)
                    err_msg = f"An error occurred while processing your request: `{str(e)}`. Please verify your network and API configuration."
                    st.error(err_msg)
                    st.session_state.chat_history.append({
                        "role": "assistant",
                        "content": err_msg,
                        "timestamp": time.strftime("%H:%M:%S"),
                        "metadata": {}
                    })
