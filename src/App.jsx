import React, { useState, useRef, useEffect } from 'react';
import { 
  FileText, Upload, CheckCircle2, XCircle, Download, Play, Zap,
  ArrowRight, ShieldCheck, Search, FileSearch, Layers, Sparkles,
  Info, Loader2, Table as TableIcon, CheckCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import * as pdfjs from 'pdfjs-dist';
import Tesseract from 'tesseract.js';

// Robust local worker setup for Vite
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const App = () => {
  const [fsdText, setFsdText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState(''); 
  const [testCases, setTestCases] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');
  const [scannedFile, setScannedFile] = useState(null);
  const [notification, setNotification] = useState(null);
  const [engine, setEngine] = useState('regex');
  const [apiKey, setApiKey] = useState(localStorage.getItem('geminiApiKey') || '');
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
         
         // Fallback to OCR if the standard extraction returns barely anything 
         // meaning it's likely a scanned (image-based) PDF.
         if (fullText.trim().length < 50) {
            setScanStatus('Empty document detected. Switching to Deep OCR Scan...');
            setNotification({ type: 'error', message: "Warning: Scanned PDF detected. Activating Deep OCR Mode..." });
            
            fullText = ""; // reset
            for (let i = 1; i <= pdf.numPages; i++) {
               setScanStatus(`OCR Processing Page ${i} of ${pdf.numPages}...`);
               
               const page = await pdf.getPage(i);
               const viewport = page.getViewport({ scale: 1.5 }); // Higher scale for better OCR accuracy
               
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
      setScannedFile(null); // Reset because it failed
    } finally {
      setIsScanning(false);
      setScanStatus('');
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const generateWithLLM = async (text, key) => {
    const prompt = `You are an expert QA Engineer. Extract comprehensive test cases from the following Functional Specification Document. Identify positive, negative, and edge cases.\n\nDocument:\n${text.substring(0, 30000)}`;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                no: { type: "INTEGER" },
                id: { type: "STRING" },
                title: { type: "STRING" },
                type: { type: "STRING", description: "positive or negative" },
                severity: { type: "STRING", description: "Low, Medium, High, or Critical" },
                description: { type: "STRING" },
                steps: { type: "ARRAY", items: { type: "STRING" } },
                expected: { type: "STRING" }
              },
              required: ["no", "id", "title", "type", "severity", "description", "steps", "expected"]
            }
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
      setNotification({ type: 'error', message: 'API Key is required for AI Semantic Engine.' });
      return;
    }

    setIsGenerating(true);
    setScanStatus(engine === 'llm' ? 'AI synthesizing test scenarios...' : 'Running local regex extractor...');
    
    try {
      if (engine === 'llm') {
        const generated = await generateWithLLM(textToProcess, apiKey);
        setTestCases(generated);
        setNotification({ type: 'success', message: `AI Generated ${generated.length} test cases!` });
      } else {
        await new Promise(resolve => setTimeout(resolve, 800)); // smooth UI transition
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
      no: cases.length + 1, id: `TC-${cases.length + 101}`, title, type, severity, description, steps, expected, actual: ""
    });

    // Clean up text format: standardize newlines and remove excessive spaces
    const cleanText = text.replace(/\r\n/g, '\n').replace(/\t/g, ' ').replace(/\n\s*\n/g, '\n');
    
    // Split into sentences using punctuation or newlines
    const segments = cleanText.split(/(?:\n|\.\s+|\?\s+|!\s+)/).map(s => s.trim()).filter(s => s.length > 15);

    const reqKeywords = ['must', 'shall', 'should', 'will', 'required', 'mandatory', 'validate', 'error', 'fail', 'able to', 'can', 'allow', 'user can', 'system shall', 'if', 'when', 'maximum', 'minimum', 'limit', 'wajib', 'harus', 'bisa', 'dapat', 'akan', 'validasi', 'gagal', 'maksimal', 'minimal', 'batas', 'ketika', 'jika'];
    
    const negativeKeywords = ['error', 'fail', 'invalid', 'reject', 'not allowed', 'cannot', 'must not', 'exceed', 'prevent', 'gagal', 'salah', 'tidak valid', 'ditolak', 'tidak boleh', 'jangan', 'melebihi', 'mencegah'];
    
    const highSeverityKeywords = ['login', 'password', 'payment', 'transaction', 'security', 'role', 'admin', 'database', 'access', 'auth', 'pembayaran', 'transaksi', 'keamanan', 'akses'];

    const extracted = new Set(); 

    segments.forEach(segment => {
      const lowerSeg = segment.toLowerCase();
      
      // Check if this segment looks like a requirement
      const isReq = reqKeywords.some(kw => lowerSeg.includes(kw));
      if (!isReq) return;

      // Avoid very long paragraphs as a single test case
      if (segment.length > 250) return;

      // Skip if already extracted a similar one
      if (extracted.has(lowerSeg)) return;
      extracted.add(lowerSeg);

      // Determine Type
      const isNegative = negativeKeywords.some(kw => lowerSeg.includes(kw));
      const type = isNegative ? 'negative' : 'positive';

      // Determine Severity
      const isCritical = highSeverityKeywords.some(kw => lowerSeg.includes(kw));
      const severity = isCritical ? 'Critical' : (isNegative ? 'High' : 'Medium');

      // Generate Title (first 6-8 words)
      const words = segment.split(' ');
      const title = words.slice(0, 7).join(' ') + (words.length > 7 ? '...' : '');
      const cleanTitle = title.charAt(0).toUpperCase() + title.slice(1);

      // Generating contextual steps based on the text
      let stepsArray = ['1. Setup initial condition or prerequisite.'];
      if(lowerSeg.includes("click") || lowerSeg.includes("button") || lowerSeg.includes("tombol") || lowerSeg.includes("klik")) {
         stepsArray.push("2. Action: Click the designated button/element.");
      } else if(lowerSeg.includes("enter") || lowerSeg.includes("input") || lowerSeg.includes("masukkan") || lowerSeg.includes("isi")) {
         stepsArray.push("2. Action: Input the required test data.");
      } else {
         stepsArray.push("2. Action: Trigger the process described.");
      }
      stepsArray.push("3. Verify the system's reaction.");

      cases.push(createCase(
        cleanTitle, 
        type, 
        severity, 
        `Requirement: ${segment}`, 
        stepsArray, 
        `System behaves as described: "${segment}"`
      ));
    });

    // Fallback parser if natural sentences weren't well formed (e.g. lists or bullet points)
    if (cases.length === 0) {
       const lines = cleanText.split('\n').map(l => l.trim()).filter(l => l.length > 10);
       lines.forEach(line => {
           // Check if it's a list item starting with a number, dash, or bullet
           if (line.match(/^[-*•\d+.)]/)) { 
               const cleanLine = line.replace(/^[-*•\d+.)]\s*/, '');
               if(cleanLine.length < 15) return;
               cases.push(createCase(
                 cleanLine.substring(0, 40) + "...", 
                 'positive', 
                 'Medium', 
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
      "No": tc.no, "ID": tc.id, "Name": tc.title, "Severity": tc.severity, "Steps": tc.steps.join("\n"), "Expected Result": tc.expected
    }));
    const ws = XLSX.utils.json_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "QA_Results");
    XLSX.writeFile(wb, "FSD_Scanned_Results.xlsx");
  };

  return (
    <div className="container">
      {/* Dynamic Notification Toast */}
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
            QA BOT INTELLIGENCE
          </div>
          <h1 style={{ fontSize: '4rem' }}>Deep Scan <span style={{ background: 'linear-gradient(to right, #fbbf24, #f59e0b)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>OCR Engine</span></h1>
        </motion.div>
      </header>

      <main style={{ maxWidth: '1000px', margin: '0 auto', display: 'grid', gap: '2.5rem' }}>
        
        <section className="glass glass-card" style={{ padding: '1.5rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
             <div className="section-title" style={{ margin: 0, fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Layers color="var(--primary)" size={20} /> Engine Configuration
             </div>
             <div style={{ display: 'flex', gap: '10px', background: 'rgba(255,255,255,0.05)', padding: '5px', borderRadius: '12px' }}>
                <button 
                   onClick={() => setEngine('regex')} 
                   style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', cursor: 'pointer', background: engine === 'regex' ? 'var(--primary)' : 'transparent', color: engine === 'regex' ? 'white' : 'var(--text-muted)', fontWeight: '600', transition: 'all 0.2s' }}>
                   Local Regex
                </button>
                <button 
                   onClick={() => setEngine('llm')} 
                   style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', cursor: 'pointer', background: engine === 'llm' ? 'linear-gradient(135deg, #10b981, #059669)' : 'transparent', color: engine === 'llm' ? 'white' : 'var(--text-muted)', fontWeight: '600', transition: 'all 0.2s' }}>
                   AI Semantic
                </button>
             </div>
          </div>
          
          <AnimatePresence>
             {engine === 'llm' && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }}>
                   <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', alignItems: 'center' }}>
                      <input 
                         type="password" 
                         placeholder="Enter Google Gemini API Key" 
                         value={apiKey} 
                         onChange={(e) => setApiKey(e.target.value)}
                         style={{ flex: 1, padding: '12px 15px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.2)', color: 'white', fontFamily: 'monospace' }}
                      />
                      <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ padding: '12px 20px', fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
                         Get API Key
                      </a>
                   </div>
                   <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '10px' }}>
                     * Your API key is stored locally in your browser and is only sent directly to Google's API.
                   </div>
                </motion.div>
             )}
          </AnimatePresence>
        </section>

        <section className="glass glass-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="section-title" style={{ margin: 0 }}>
              {(isScanning || isGenerating) ? <Loader2 className="animate-spin" color="var(--primary)" /> : <FileSearch color="var(--primary)" />}
              {isScanning ? scanStatus || `Analyzing ${scannedFile}...` : isGenerating ? "Generating Test Cases..." : "Requirement Scan Engine"}
            </div>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
               {scannedFile && !isScanning && !isGenerating && <div style={{ marginRight: '1rem', display: 'flex', alignItems: 'center', gap: '10px', color: '#10b981', background: 'rgba(16, 185, 129, 0.08)', padding: '8px 18px', borderRadius: '100px', fontSize: '0.9rem', border: '1px solid rgba(16, 185, 129, 0.2)' }}><CheckCircle size={16} /> Ready: {scannedFile}</div>}
               <input type="file" ref={fileInputRef} style={{ display: 'none' }} accept=".pdf,.docx,.txt" onChange={handleFileUpload} />
               <button className="btn btn-secondary" onClick={() => fileInputRef.current.click()} disabled={isScanning || isGenerating}>
                 <Upload size={18} /> Upload Scanned PDF
               </button>
            </div>
          </div>
        </section>

        <AnimatePresence>
          {testCases && (
            <motion.section initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="glass glass-card" style={{ padding: '0' }}>
               <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2rem 2.5rem', borderBottom: '1px solid var(--color-glass-border)' }}>
                <div className="section-title" style={{ margin: 0 }}><TableIcon color="var(--secondary)" /> Extracted Cases ({testCases.length})</div>
                <button className="btn btn-primary" onClick={exportToExcel} style={{ background: '#10b981', padding: '0.6rem 1.4rem' }}>
                  <Download size={18} /> Export Excel
                </button>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ minWidth: '950px' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                      <th style={{ padding: '1.2rem', color: 'var(--text-muted)' }}>ID</th>
                      <th style={{ padding: '1.2rem', color: 'var(--text-muted)' }}>Test Scenario</th>
                      <th style={{ padding: '1.2rem', color: 'var(--text-muted)' }}>Severity</th>
                      <th style={{ padding: '1.2rem', color: 'var(--text-muted)' }}>Expected Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testCases.map((tc, idx) => (
                      <tr key={idx}>
                        <td style={{ padding: '1.5rem', borderBottom: '1px solid var(--color-glass-border)', textAlign: 'center' }}>
                          <span style={{ fontWeight: '800', color: 'var(--primary)' }}>{tc.id}</span>
                        </td>
                        <td style={{ padding: '1.5rem', borderBottom: '1px solid var(--color-glass-border)' }}>
                          <div style={{ fontWeight: '600', marginBottom: '6px' }}>{tc.title}</div>
                          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{tc.description}</div>
                        </td>
                        <td style={{ padding: '1.5rem', borderBottom: '1px solid var(--color-glass-border)', textAlign: 'center' }}>
                          <span style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: '900', background: tc.severity === 'Critical' ? 'rgba(244,63,94,0.1)' : 'rgba(245,158,11,0.1)', color: tc.severity === 'Critical' ? '#fb7185' : '#fbbf24' }}>{tc.severity.toUpperCase()}</span>
                        </td>
                        <td style={{ padding: '1.5rem', borderBottom: '1px solid var(--color-glass-border)' }}>
                          <div style={{ display: 'flex', gap: '10px', alignItems: 'start' }}>
                             <CheckCircle2 color="#34d399" size={18} style={{ flexShrink: 0, marginTop: '2px' }} />
                             <span style={{ fontSize: '0.95rem' }}>{tc.expected}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

export default App;
