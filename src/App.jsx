import React, { useState, useRef, useEffect } from 'react';
import { 
  FileText, Upload, CheckCircle2, XCircle, Download, Play, Zap,
  ArrowRight, ShieldCheck, Search, FileSearch, Layers, Sparkles,
  Info, Loader2, Table as TableIcon, CheckCircle, AlertTriangle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import * as pdfjs from 'pdfjs-dist';
import Tesseract from 'tesseract.js';

// Robust local worker setup for Vite
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// Module color mapping
const MODULE_COLORS = {
  CASA: { bg: 'rgba(6, 182, 212, 0.15)', color: '#06b6d4', border: 'rgba(6, 182, 212, 0.3)' },
  LENDING: { bg: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', border: 'rgba(245, 158, 11, 0.3)' },
  PAYMENTS: { bg: 'rgba(168, 85, 247, 0.15)', color: '#a855f7', border: 'rgba(168, 85, 247, 0.3)' },
  GL: { bg: 'rgba(34, 197, 94, 0.15)', color: '#22c55e', border: 'rgba(34, 197, 94, 0.3)' },
  TD: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', border: 'rgba(59, 130, 246, 0.3)' },
};

const getModuleStyle = (mod) => MODULE_COLORS[mod?.toUpperCase()] || { bg: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', border: 'rgba(255,255,255,0.1)' };

const App = () => {
  const [fsdText, setFsdText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState(''); 
  const [testCases, setTestCases] = useState(null);
  const [scannedFile, setScannedFile] = useState(null);
  const [notification, setNotification] = useState(null);
  const [engine, setEngine] = useState('llm');
  const [apiKey, setApiKey] = useState(localStorage.getItem('geminiApiKey') || '');
  
  // FLEXCUBE Project Settings
  const [level, setLevel] = useState('detailed');
  const [bankingFocus, setBankingFocus] = useState('all');
  const [module, setModule] = useState('auto');
  const [extraAnalysis, setExtraAnalysis] = useState(null);
  
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (apiKey) localStorage.setItem('geminiApiKey', apiKey);
  }, [apiKey]);

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setIsScanning(true);
    setScanStatus('Reading file format...');
    setScannedFile(file.name);
    setTestCases(null);
    setExtraAnalysis(null);
    let extractedText = "";

    try {
      if (file.name.toLowerCase().endsWith('.docx')) {
         setScanStatus('Extracting DOCX text...');
         const arrayBuffer = await file.arrayBuffer();
         const result = await mammoth.extractRawText({ arrayBuffer });
         extractedText = result.value;
      } else if (file.name.toLowerCase().endsWith('.pdf')) {
         setScanStatus('Attempting standard PDF extraction...');
         const arrayBuffer = await file.arrayBuffer();
         const loadingTask = pdfjs.getDocument({
           data: arrayBuffer,
           useWorkerFetch: true,
           isEvalSupported: false,
         });

         const pdf = await loadingTask.promise;
         let fullText = "";
         for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            fullText += content.items.map(item => item.str).join(' ') + "\n";
         }
         
         if (fullText.trim().length < 50) {
            setScanStatus('Scanned document detected. Switching to Deep OCR...');
            setNotification({ type: 'error', message: "Scanned PDF detected. Activating Deep OCR Mode..." });
            
            fullText = "";
            for (let i = 1; i <= pdf.numPages; i++) {
               setScanStatus(`OCR Processing Page ${i} of ${pdf.numPages}...`);
               const page = await pdf.getPage(i);
               const viewport = page.getViewport({ scale: 1.5 });
               const canvas = document.createElement('canvas');
               const context = canvas.getContext('2d');
               canvas.height = viewport.height;
               canvas.width = viewport.width;
               await page.render({ canvasContext: context, viewport: viewport }).promise;
               const imgData = canvas.toDataURL("image/png");
               const { data: { text } } = await Tesseract.recognize(imgData, 'eng+ind');
               fullText += text + "\n";
            }
         }
         
         extractedText = fullText;
      } else if (file.name.toLowerCase().endsWith('.txt')) {
         setScanStatus('Reading TXT file...');
         extractedText = await file.text();
      } else {
         throw new Error("Format not supported. Use PDF, DOCX, or TXT.");
      }

      if (!extractedText.trim()) throw new Error("Document appears to be completely empty even after OCR scan.");

      setFsdText(extractedText);
      setNotification({ type: 'success', message: `${file.name} successfully scanned!` });
      generateTestCases(extractedText);
      
    } catch (err) {
      console.error("Scanning Error:", err);
      setNotification({ type: 'error', message: `Scan Error: ${err.message || "Failed to parse document"}` });
      setScannedFile(null);
    } finally {
      setIsScanning(false);
      setScanStatus('');
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const generateWithLLM = async (text, key) => {
    const moduleInstruction = module === 'auto' 
      ? 'Auto-detect the FLEXCUBE module from the FSD content.' 
      : `Target Module: ${module}`;
    
    const prompt = `You are a Senior QA Engineer specialized in Oracle FLEXCUBE (Retail, Corporate, CASA, Lending, Payments, GL).

Convert the following FSD into banking-grade, production-ready Test Cases.

### FLEXCUBE DOMAIN CONTEXT (MANDATORY)
You MUST understand: Modules (CASA, LENDING, PAYMENTS, TD, GL), Events (INIT, LIQD, ROLL, ACCRUAL, REVERSAL), EOD/BOD processing, Accounting entries (DR/CR), Value date vs Booking date, Interest calculation & liquidation, Batch jobs, Maker-Checker flow, Limits, validations, overrides.

### PROJECT CONFIGURATION
- ${moduleInstruction}
- Level: ${level}
- Focus: ${bankingFocus}

### MANDATORY COVERAGE
✅ Functional: Valid flow, Invalid handling, Maker-Checker authorization
✅ Financial: Balance impact, GL posting (DR/CR), Interest calculation, Fee/charge
✅ Date Logic: Backdated, Future dated, Value date vs Booking date
✅ Batch/EOD: Before EOD, After EOD, Re-run/reprocessing
✅ Reversal: Full reversal, Partial reversal, Reversal after EOD
✅ Edge Cases: Limit breach, Insufficient balance, Duplicate transaction, System failure/retry

### FSD CONTENT:
${text.substring(0, 30000)}

### RULES
- NEVER skip financial validation or GL validation
- ALWAYS include EOD and reversal scenarios
- ALWAYS include negative scenarios
- If FSD is incomplete, state assumptions clearly
- Assign severity: Critical=Financial impact/wrong GL/EOD failure, High=Transaction failure, Medium=Partial issue, Low=UI/minor
- Use tags: #CASA #LENDING #PAYMENT #GL #EOD #REVERSAL #INTEREST #LIMIT #BATCH #API #VALIDATION`;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              testCases: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    id: { type: "STRING" },
                    module: { type: "STRING", description: "CASA, LENDING, PAYMENTS, GL, or TD" },
                    event: { type: "STRING", description: "INIT, LIQD, ROLL, ACCRUAL, REVERSAL, AUTH, EOD, etc." },
                    scenario: { type: "STRING" },
                    description: { type: "STRING" },
                    preconditions: { type: "STRING" },
                    steps: { type: "ARRAY", items: { type: "STRING" } },
                    testData: { type: "STRING" },
                    expectedResult: { type: "STRING" },
                    glImpact: { type: "STRING", description: "DR/CR accounting entries. Use N/A if not applicable." },
                    eodImpact: { type: "STRING", description: "Yes/No with brief explanation" },
                    priority: { type: "STRING", enum: ["Critical", "High", "Medium", "Low"] },
                    severity: { type: "STRING", enum: ["Critical", "High", "Medium", "Low"] },
                    tags: { type: "ARRAY", items: { type: "STRING" } }
                  },
                  required: ["id", "module", "event", "scenario", "description", "steps", "expectedResult", "glImpact", "eodImpact", "priority", "severity", "tags"]
                }
              },
              coveragePercentage: { type: "STRING", description: "Estimated test coverage percentage" },
              coverageSummary: { type: "STRING" },
              missingRequirements: { type: "ARRAY", items: { type: "STRING" } },
              financialRiskAnalysis: { type: "ARRAY", items: { type: "STRING" } },
              riskAnalysis: { type: "ARRAY", items: { type: "STRING" } }
            },
            required: ["testCases", "coveragePercentage", "coverageSummary", "missingRequirements", "financialRiskAnalysis", "riskAnalysis"]
          }
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || "Failed to generate AI tests.");
    }

    const data = await response.json();
    return JSON.parse(data.candidates[0].content.parts[0].text);
  };

  const generateTestCases = async (textToProcess = fsdText) => {
    if (!textToProcess.trim()) return;
    
    if (engine === 'llm' && !apiKey.trim()) {
      setNotification({ type: 'error', message: 'API Key is required for FLEXCUBE AI Engine.' });
      return;
    }

    setIsGenerating(true);
    setExtraAnalysis(null);
    setScanStatus(engine === 'llm' ? 'AI synthesizing FLEXCUBE test scenarios...' : 'Running local regex extractor...');
    
    try {
      if (engine === 'llm') {
        const generated = await generateWithLLM(textToProcess, apiKey);
        setTestCases(generated.testCases);
        setExtraAnalysis({
          coveragePercentage: generated.coveragePercentage,
          coverageSummary: generated.coverageSummary,
          missingRequirements: generated.missingRequirements,
          financialRiskAnalysis: generated.financialRiskAnalysis,
          riskAnalysis: generated.riskAnalysis
        });
        setNotification({ type: 'success', message: `AI Generated ${generated.testCases.length} banking-grade test cases!` });
      } else {
        await new Promise(resolve => setTimeout(resolve, 800));
        const generated = interpretFSD(textToProcess);
        setTestCases(generated);
        setNotification({ type: 'success', message: `Regex Extracted ${generated.length} test cases!` });
      }
    } catch (err) {
      console.error(err);
      setNotification({ type: 'error', message: `Generation failed: ${err.message}` });
    } finally {
      setIsGenerating(false);
      setScanStatus('');
    }
  };

  const interpretFSD = (text) => {
    const cases = [];
    
    const createCase = (title, type, severity, description, steps, expected) => ({
      no: cases.length + 1, 
      id: `TC-${cases.length + 101}`, 
      module: 'N/A',
      event: 'N/A',
      scenario: title, 
      type, 
      severity, 
      priority: severity,
      description, 
      steps, 
      expectedResult: expected, 
      preconditions: "N/A",
      testData: "N/A",
      glImpact: "N/A",
      eodImpact: "N/A",
      tags: [type === 'negative' ? '#NEGATIVE' : '#POSITIVE', '#REGEX'],
      actual: ""
    });

    const cleanText = text.replace(/\r\n/g, '\n').replace(/\t/g, ' ').replace(/\n\s*\n/g, '\n');
    const segments = cleanText.split(/(?:\n|\.\s+|\?\s+|!\s+)/).map(s => s.trim()).filter(s => s.length > 15);

    const reqKeywords = ['must', 'shall', 'should', 'will', 'required', 'mandatory', 'validate', 'error', 'fail', 'able to', 'can', 'allow', 'user can', 'system shall', 'if', 'when', 'maximum', 'minimum', 'limit', 'wajib', 'harus', 'bisa', 'dapat', 'akan', 'validasi', 'gagal', 'maksimal', 'minimal', 'batas', 'ketika', 'jika'];
    const negativeKeywords = ['error', 'fail', 'invalid', 'reject', 'not allowed', 'cannot', 'must not', 'exceed', 'prevent', 'gagal', 'salah', 'tidak valid', 'ditolak', 'tidak boleh', 'jangan', 'melebihi', 'mencegah'];
    const highSeverityKeywords = ['login', 'password', 'payment', 'transaction', 'security', 'role', 'admin', 'database', 'access', 'auth', 'pembayaran', 'transaksi', 'keamanan', 'akses', 'gl', 'eod', 'reversal', 'debit', 'credit', 'balance', 'interest', 'accrual'];

    const extracted = new Set(); 

    segments.forEach(segment => {
      const lowerSeg = segment.toLowerCase();
      const isReq = reqKeywords.some(kw => lowerSeg.includes(kw));
      if (!isReq) return;
      if (segment.length > 250) return;
      if (extracted.has(lowerSeg)) return;
      extracted.add(lowerSeg);

      const isNegative = negativeKeywords.some(kw => lowerSeg.includes(kw));
      const type = isNegative ? 'negative' : 'positive';
      const isCritical = highSeverityKeywords.some(kw => lowerSeg.includes(kw));
      const severity = isCritical ? 'Critical' : (isNegative ? 'High' : 'Medium');

      const words = segment.split(' ');
      const title = words.slice(0, 7).join(' ') + (words.length > 7 ? '...' : '');
      const cleanTitle = title.charAt(0).toUpperCase() + title.slice(1);

      let stepsArray = ['1. Setup initial condition or prerequisite.'];
      if(lowerSeg.includes("click") || lowerSeg.includes("button") || lowerSeg.includes("tombol") || lowerSeg.includes("klik")) {
         stepsArray.push("2. Action: Click the designated button/element.");
      } else if(lowerSeg.includes("enter") || lowerSeg.includes("input") || lowerSeg.includes("masukkan") || lowerSeg.includes("isi")) {
         stepsArray.push("2. Action: Input the required test data.");
      } else {
         stepsArray.push("2. Action: Trigger the process described.");
      }
      stepsArray.push("3. Verify the system's reaction.");

      cases.push(createCase(cleanTitle, type, severity, `Requirement: ${segment}`, stepsArray, `System behaves as described: "${segment}"`));
    });

    if (cases.length === 0) {
       const lines = cleanText.split('\n').map(l => l.trim()).filter(l => l.length > 10);
       lines.forEach(line => {
           if (line.match(/^[-*•\d+.)]/)) { 
               const cleanLine = line.replace(/^[-*•\d+.)]\s*/, '');
               if(cleanLine.length < 15) return;
               cases.push(createCase(
                 cleanLine.substring(0, 40) + "...", 'positive', 'Medium', 
                 `List Item Requirement: ${cleanLine}`, 
                 ['1. Prepare to test list item.', '2. Execute action.', '3. Verify result.'], 
                 'Condition is successfully met.'
               ));
           }
       });
    }

    if (cases.length === 0) {
      cases.push(createCase('Base Functional Test', 'positive', 'High', 'Verify primary spec generated from OCR text.', ['Execute main feature described in document'], 'Successful completion.'));
    }

    return cases;
  };

  const exportToExcel = () => {
    if (!testCases) return;
    const wsData = testCases.map(tc => ({
      "TC_ID": tc.id,
      "Module": tc.module || "N/A",
      "Event": tc.event || "N/A",
      "Scenario": tc.scenario, 
      "Description": tc.description,
      "Preconditions": tc.preconditions || "N/A",
      "Steps": tc.steps.join("\n"), 
      "Test Data": tc.testData || "N/A",
      "Expected Result": tc.expectedResult,
      "GL Impact": tc.glImpact || "N/A",
      "EOD Impact": tc.eodImpact || "N/A",
      "Priority": tc.priority,
      "Severity": tc.severity,
      "Tags": tc.tags?.join(", ") || ""
    }));
    const ws = XLSX.utils.json_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "FLEXCUBE_TestCases");
    XLSX.writeFile(wb, "FLEXCUBE_TestCases.xlsx");
  };

  const SeverityBadge = ({ value }) => {
    const colors = {
      Critical: { bg: 'rgba(244,63,94,0.12)', color: '#fb7185' },
      High: { bg: 'rgba(245,158,11,0.12)', color: '#fbbf24' },
      Medium: { bg: 'rgba(59,130,246,0.12)', color: '#60a5fa' },
      Low: { bg: 'rgba(148,163,184,0.12)', color: '#94a3b8' },
    };
    const s = colors[value] || colors.Medium;
    return <span style={{ padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: '900', background: s.bg, color: s.color, letterSpacing: '0.05em' }}>{value?.toUpperCase()}</span>;
  };

  return (
    <div className="container">
      {/* Notification Toast */}
      <AnimatePresence>
        {notification && (
          <motion.div initial={{ opacity: 0, scale: 0.9, x: 20 }} animate={{ opacity: 1, scale: 1, x: 0 }} exit={{ opacity: 0, scale: 0.9, x: 20 }} className="glass"
            style={{ position: 'fixed', top: '2rem', right: '2rem', zIndex: 1000, padding: '1rem 2rem', borderRadius: '16px', borderLeft: `6px solid ${notification.type === 'error' ? '#fb7185' : '#34d399'}`, display: 'flex', alignItems: 'center', gap: '15px', color: 'white', fontWeight: '600', boxShadow: '0 20px 40px rgba(0,0,0,0.4)' }}>
            {notification.type === 'error' ? <XCircle color="#fb7185" size={24} /> : <CheckCircle color="#34d399" size={24} />}
            {notification.message}
          </motion.div>
        )}
      </AnimatePresence>

      <header style={{ textAlign: 'center', marginBottom: '4rem' }}>
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }}>
          <div style={{ display: 'inline-flex', padding: '0.6rem 1.2rem', background: 'rgba(99, 102, 241, 0.1)', borderRadius: '100px', color: 'var(--primary)', fontWeight: '700', marginBottom: '1.5rem', border: '1px solid var(--primary)', letterSpacing: '0.05em' }}>
            <Sparkles size={16} style={{ marginRight: '8px' }} />
            FLEXCUBE QA INTELLIGENCE
          </div>
          <h1 style={{ fontSize: '3.5rem' }}>Banking-Grade <span style={{ background: 'linear-gradient(to right, #fbbf24, #f59e0b)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Test Engine</span></h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', maxWidth: '600px', margin: '0 auto' }}>FSD → Production-Ready Test Cases with GL, EOD & Financial Validation</p>
        </motion.div>
      </header>

      <main style={{ maxWidth: '1100px', margin: '0 auto', display: 'grid', gap: '2.5rem' }}>
        
        {/* Config Panel */}
        <section className="glass glass-card" style={{ padding: '1.5rem 2.5rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
          <div>
            <div className="section-title" style={{ margin: 0, fontSize: '1.1rem', marginBottom: '1rem' }}>
               <ShieldCheck color="var(--primary)" size={20} /> FLEXCUBE Configuration
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="input-group">
                <label style={{ fontSize: '0.7rem', fontWeight: 'bold', color: 'var(--text-muted)', marginBottom: '4px', display: 'block', letterSpacing: '0.1em' }}>MODULE</label>
                <select value={module} onChange={(e) => setModule(e.target.value)} style={{ width: '100%', padding: '10px', borderRadius: '8px', background: 'rgba(0,0,0,0.3)', color: 'white', border: '1px solid rgba(255,255,255,0.1)' }}>
                  <option value="auto">Auto-Detect</option>
                  <option value="CASA">CASA</option>
                  <option value="LENDING">Lending</option>
                  <option value="PAYMENTS">Payments</option>
                  <option value="GL">General Ledger</option>
                  <option value="TD">Term Deposit</option>
                </select>
              </div>
              <div className="input-group">
                <label style={{ fontSize: '0.7rem', fontWeight: 'bold', color: 'var(--text-muted)', marginBottom: '4px', display: 'block', letterSpacing: '0.1em' }}>FOCUS</label>
                <select value={bankingFocus} onChange={(e) => setBankingFocus(e.target.value)} style={{ width: '100%', padding: '10px', borderRadius: '8px', background: 'rgba(0,0,0,0.3)', color: 'white', border: '1px solid rgba(255,255,255,0.1)' }}>
                  <option value="all">All Scenarios</option>
                  <option value="financial">Financial (GL/DR/CR)</option>
                  <option value="eod">EOD / Batch</option>
                  <option value="reversal">Reversal</option>
                  <option value="negative">Negative Only</option>
                </select>
              </div>
              <div className="input-group">
                <label style={{ fontSize: '0.7rem', fontWeight: 'bold', color: 'var(--text-muted)', marginBottom: '4px', display: 'block', letterSpacing: '0.1em' }}>LEVEL</label>
                <select value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: '100%', padding: '10px', borderRadius: '8px', background: 'rgba(0,0,0,0.3)', color: 'white', border: '1px solid rgba(255,255,255,0.1)' }}>
                  <option value="simple">Simple</option>
                  <option value="detailed">Detailed</option>
                  <option value="exhaustive">Exhaustive</option>
                </select>
              </div>
              <div className="input-group">
                 <label style={{ fontSize: '0.7rem', fontWeight: 'bold', color: 'var(--text-muted)', marginBottom: '4px', display: 'block', letterSpacing: '0.1em' }}>ENGINE</label>
                 <div style={{ display: 'flex', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)' }}>
                    <button onClick={() => setEngine('regex')} style={{ flex: 1, border: 'none', background: engine === 'regex' ? 'var(--primary)' : 'transparent', color: 'white', padding: '10px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>REGEX</button>
                    <button onClick={() => setEngine('llm')} style={{ flex: 1, border: 'none', background: engine === 'llm' ? 'var(--primary)' : 'transparent', color: 'white', padding: '10px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>AI / LLM</button>
                 </div>
              </div>
            </div>
          </div>

          <div>
            <div className="section-title" style={{ margin: 0, fontSize: '1.1rem', marginBottom: '1rem' }}>
               <Layers color="var(--primary)" size={20} /> Gemini API Key
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <input 
                 type="password" 
                 placeholder="Enter Google Gemini API Key" 
                 value={apiKey} 
                 onChange={(e) => setApiKey(e.target.value)}
                 style={{ flex: 1, padding: '12px 15px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.2)', color: 'white', fontFamily: 'monospace' }}
              />
              <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ padding: '12px 20px', fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
                 Get Key
              </a>
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '10px' }}>
              * Powered by Gemini 1.5 Flash. Key stored locally, sent only to Google API.
            </div>
          </div>
        </section>

        {/* Scan Engine */}
        <section className="glass glass-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="section-title" style={{ margin: 0 }}>
              {(isScanning || isGenerating) ? <Loader2 className="animate-spin" color="var(--primary)" /> : <FileSearch color="var(--primary)" />}
              {isScanning ? scanStatus || `Analyzing ${scannedFile}...` : isGenerating ? scanStatus || "Generating Test Cases..." : "FSD Upload & Scan"}
            </div>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
               {scannedFile && !isScanning && !isGenerating && <div style={{ marginRight: '1rem', display: 'flex', alignItems: 'center', gap: '10px', color: '#10b981', background: 'rgba(16, 185, 129, 0.08)', padding: '8px 18px', borderRadius: '100px', fontSize: '0.9rem', border: '1px solid rgba(16, 185, 129, 0.2)' }}><CheckCircle size={16} /> Ready: {scannedFile}</div>}
               <input type="file" ref={fileInputRef} style={{ display: 'none' }} accept=".pdf,.docx,.txt" onChange={handleFileUpload} />
               <button className="btn btn-secondary" onClick={() => fileInputRef.current.click()} disabled={isScanning || isGenerating}>
                 <Upload size={18} /> Upload FSD
               </button>
            </div>
          </div>
        </section>

        <AnimatePresence>
          {testCases && (
            <motion.section initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="glass glass-card" style={{ padding: '0' }}>
               <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2rem 2.5rem', borderBottom: '1px solid var(--color-glass-border)' }}>
                <div className="section-title" style={{ margin: 0 }}>
                  <TableIcon color="var(--secondary)" />
                  FLEXCUBE Test Cases ({testCases.length})
                  {extraAnalysis?.coveragePercentage && (
                    <span style={{ marginLeft: '12px', padding: '4px 12px', borderRadius: '100px', fontSize: '11px', fontWeight: '800', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                      {extraAnalysis.coveragePercentage} Coverage
                    </span>
                  )}
                </div>
                <button className="btn btn-primary" onClick={exportToExcel} style={{ background: '#10b981', padding: '0.6rem 1.4rem' }}>
                  <Download size={18} /> Export Excel
                </button>
              </div>

              {/* Coverage Summary */}
              {extraAnalysis?.coverageSummary && (
                <div style={{ padding: '1rem 2.5rem', background: 'rgba(16, 185, 129, 0.03)', borderBottom: '1px solid var(--color-glass-border)', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  <strong style={{ color: '#10b981' }}>Coverage: </strong>{extraAnalysis.coverageSummary}
                </div>
              )}

              <div style={{ overflowX: 'auto' }}>
                <table style={{ minWidth: '1400px' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                      <th style={{ padding: '1rem', color: 'var(--text-muted)', width: '80px' }}>ID</th>
                      <th style={{ padding: '1rem', color: 'var(--text-muted)', width: '90px' }}>Module</th>
                      <th style={{ padding: '1rem', color: 'var(--text-muted)', width: '80px' }}>Event</th>
                      <th style={{ padding: '1rem', color: 'var(--text-muted)' }}>Scenario</th>
                      <th style={{ padding: '1rem', color: 'var(--text-muted)', width: '100px' }}>Priority</th>
                      <th style={{ padding: '1rem', color: 'var(--text-muted)' }}>Expected & GL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testCases.map((tc, idx) => {
                      const modStyle = getModuleStyle(tc.module);
                      return (
                      <tr key={idx}>
                        <td style={{ padding: '1.2rem', borderBottom: '1px solid var(--color-glass-border)', textAlign: 'center', verticalAlign: 'top' }}>
                          <span style={{ fontWeight: '800', color: 'var(--primary)', fontSize: '0.85rem' }}>{tc.id}</span>
                        </td>
                        <td style={{ padding: '1.2rem', borderBottom: '1px solid var(--color-glass-border)', textAlign: 'center', verticalAlign: 'top' }}>
                          <span style={{ padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: '800', background: modStyle.bg, color: modStyle.color, border: `1px solid ${modStyle.border}`, letterSpacing: '0.05em' }}>{tc.module || 'N/A'}</span>
                        </td>
                        <td style={{ padding: '1.2rem', borderBottom: '1px solid var(--color-glass-border)', textAlign: 'center', verticalAlign: 'top' }}>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600' }}>{tc.event || 'N/A'}</span>
                        </td>
                        <td style={{ padding: '1.2rem', borderBottom: '1px solid var(--color-glass-border)', verticalAlign: 'top' }}>
                          <div style={{ fontWeight: '600', marginBottom: '4px', fontSize: '0.9rem' }}>{tc.scenario}</div>
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>{tc.description}</div>
                          {tc.preconditions && tc.preconditions !== 'N/A' && (
                            <div style={{ fontSize: '0.72rem', marginTop: '4px', padding: '4px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px', borderLeft: '2px solid var(--primary)' }}>
                              <span style={{ color: 'var(--primary)', fontWeight: 'bold' }}>PRE: </span>{tc.preconditions}
                            </div>
                          )}
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', marginTop: '6px' }}>
                             {tc.tags?.map((tag, i) => (
                               <span key={i} style={{ fontSize: '9px', padding: '2px 6px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', color: 'var(--text-muted)' }}>{tag}</span>
                             ))}
                          </div>
                        </td>
                        <td style={{ padding: '1.2rem', borderBottom: '1px solid var(--color-glass-border)', textAlign: 'center', verticalAlign: 'top' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center' }}>
                            <SeverityBadge value={tc.priority} />
                            <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>SEV: {tc.severity}</span>
                          </div>
                        </td>
                        <td style={{ padding: '1.2rem', borderBottom: '1px solid var(--color-glass-border)', verticalAlign: 'top' }}>
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'start' }}>
                             <CheckCircle2 color="#34d399" size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                             <div style={{ fontSize: '0.85rem' }}>
                                <div style={{ fontWeight: '600' }}>{tc.expectedResult}</div>
                                {tc.glImpact && tc.glImpact !== 'N/A' && (
                                  <div style={{ marginTop: '6px', padding: '4px 8px', background: 'rgba(34, 197, 94, 0.05)', borderRadius: '4px', fontSize: '0.75rem', borderLeft: '2px solid #22c55e' }}>
                                    <span style={{ fontWeight: 'bold', color: '#22c55e' }}>GL: </span>
                                    <span style={{ color: 'var(--text-muted)' }}>{tc.glImpact}</span>
                                  </div>
                                )}
                                {tc.eodImpact && tc.eodImpact !== 'N/A' && (
                                  <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.72rem' }}>
                                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: tc.eodImpact?.toLowerCase().startsWith('yes') ? '#fbbf24' : '#94a3b8', flexShrink: 0 }}></span>
                                    <span style={{ color: 'var(--text-muted)' }}>EOD: {tc.eodImpact}</span>
                                  </div>
                                )}
                                {tc.testData && tc.testData !== 'N/A' && (
                                  <div style={{ marginTop: '4px', fontSize: '0.72rem', color: '#60a5fa' }}>Data: {tc.testData}</div>
                                )}
                             </div>
                          </div>
                        </td>
                      </tr>
                    )})}
                  </tbody>
                </table>
              </div>
            </motion.section>
          )}

          {/* Analysis Panels */}
          {extraAnalysis && (
             <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
                
                {/* Financial Risk */}
                <div className="glass glass-card">
                   <div className="section-title" style={{ fontSize: '1.1rem' }}><AlertTriangle color="#fb7185" size={18} /> Financial Risk Analysis</div>
                   <ul style={{ paddingLeft: '1.5rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                      {extraAnalysis.financialRiskAnalysis?.map((risk, i) => <li key={i} style={{ marginBottom: '8px' }}>{risk}</li>)}
                      {(!extraAnalysis.financialRiskAnalysis || extraAnalysis.financialRiskAnalysis.length === 0) && <li>No financial risks detected.</li>}
                   </ul>
                </div>

                {/* Missing Requirements */}
                <div className="glass glass-card">
                   <div className="section-title" style={{ fontSize: '1.1rem' }}><Search color="#fbbf24" size={18} /> Missing Requirements</div>
                   <ul style={{ paddingLeft: '1.5rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                      {extraAnalysis.missingRequirements?.map((req, i) => <li key={i} style={{ marginBottom: '8px' }}>{req}</li>)}
                      {(!extraAnalysis.missingRequirements || extraAnalysis.missingRequirements.length === 0) && <li>No missing requirements detected.</li>}
                   </ul>
                </div>

                {/* General Risk */}
                {extraAnalysis.riskAnalysis?.length > 0 && (
                  <div className="glass glass-card" style={{ gridColumn: '1 / -1' }}>
                     <div className="section-title" style={{ fontSize: '1.1rem' }}><Info color="#60a5fa" size={18} /> General Risk Analysis</div>
                     <ul style={{ paddingLeft: '1.5rem', color: 'var(--text-muted)', fontSize: '0.85rem', columns: 2, columnGap: '2rem' }}>
                        {extraAnalysis.riskAnalysis.map((risk, i) => <li key={i} style={{ marginBottom: '8px' }}>{risk}</li>)}
                     </ul>
                  </div>
                )}
             </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

export default App;
