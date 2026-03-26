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
  const [scanStatus, setScanStatus] = useState(''); // Text like "Extracting text...", "Deep OCR Scanning..."
  const [testCases, setTestCases] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');
  const [scannedFile, setScannedFile] = useState(null);
  const [notification, setNotification] = useState(null);
  const fileInputRef = useRef(null);

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

  const generateTestCases = (textToProcess = fsdText) => {
    if (!textToProcess.trim()) return;
    setIsGenerating(true);
    
    setTimeout(() => {
      const generated = interpretFSD(textToProcess);
      setTestCases(generated);
      setIsGenerating(false);
      setNotification({ type: 'success', message: `Test Suite Generated (${generated.length} cases)` });
    }, 1500);
  };

  const interpretFSD = (text) => {
    const cases = [];
    const lowerText = text.toLowerCase();
    
    const createCase = (title, type, severity, description, steps, expected) => ({
      no: cases.length + 1, id: `TC-${cases.length + 101}`, title, type, severity, description, steps, expected, actual: ""
    });

    if (lowerText.includes('login') || lowerText.includes('credential')) {
      cases.push(createCase('Login Access Control', 'positive', 'Critical', 'Verify main login flow.', ['Navigate to login', 'Enter credentials', 'Click Login'], 'User hits Dashboard.'));
      cases.push(createCase('Wrong Password Rejection', 'negative', 'High', 'Security check.', ['Enter wrong password', 'Submit'], 'Access denied message.'));
    }

    if (lowerText.includes('mandatory') || lowerText.includes('required') || lowerText.includes('field')) {
      cases.push(createCase('Form Field Validation', 'negative', 'Medium', 'Mandatory check.', ['Leave fields empty', 'Click Submit'], 'Valiation errors shown.'));
    }

    if (lowerText.includes('amount') || lowerText.includes('nominal')) {
      cases.push(createCase('Input Amount Integrity', 'positive', 'High', 'Verify financial amount input handling.', ['Enter valid numerical amount', 'Submit the form'], 'Amount is processed correctly.'));
      cases.push(createCase('Invalid Amount Rejection', 'negative', 'High', 'Boundary validation.', ['Enter negative amount or text', 'Submit'], 'Validation error triggers.'));
    }

    if (lowerText.includes('email')) {
      cases.push(createCase('Email Format Integrity', 'negative', 'Medium', 'Pattern check.', ['Enter improper email', 'Submit'], 'Syntax error alert.'));
    }

    if (lowerText.includes('admin') || lowerText.includes('role')) {
      cases.push(createCase('Role-Based Access', 'negative', 'High', 'Permission check.', ['Visit admin URL as regular user'], '403 Forbidden shown.'));
    }

    if (lowerText.includes('upload')) {
       cases.push(createCase('File Size Constraint', 'negative', 'Medium', 'Limit check.', ['Select large file (>5MB)', 'Upload'], 'Rejection notice.'));
    }

    if (cases.length === 0) {
      cases.push(createCase('Base Functional Test', 'positive', 'High', 'Verify primary spec dynamically generated from OCR text.', ['Execute main feature described in document'], 'Successful completion.'));
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
