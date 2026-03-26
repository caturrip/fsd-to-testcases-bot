import fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const pdfPath = 'C:\\Users\\catur\\Downloads\\LPEI_FS_Vami_Amount_V0.2.pdf';

async function testPdf() {
  try {
    console.log("Reading file:", pdfPath);
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    console.log("File size:", data.length);
    
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdf = await loadingTask.promise;
    
    console.log(`PDF loaded successfully. Total Pages: ${pdf.numPages}`);
    let fullText = "";
    
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str).join(' ');
      fullText += text + "\n";
    }
    
    console.log("Extracted Text Length:", fullText.length);
    console.log("First 200 chars:", fullText.substring(0, 200));
    
    if (fullText.trim().length === 0) {
      console.log("WARNING: Document is empty or scanned (image-based).");
    }
  } catch (error) {
    console.error("Error parsing PDF:", error);
  }
}

testPdf();
