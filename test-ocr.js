const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');
const pdfParse = require('pdf-parse');

console.log('pdfParse import:', pdfParse);

// --- OCR HELPER FUNCTIONS ---
async function extractMetadataFromImage(imagePath) {
    console.log(`Processing Image: ${imagePath}`);
    const worker = await createWorker('eng');
    const ret = await worker.recognize(imagePath);
    await worker.terminate();
    
    return processExtractedText(ret.data.text);
}

async function extractMetadataFromPdf(pdfPath) {
    console.log(`Processing PDF: ${pdfPath}`);
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(dataBuffer);
    return processExtractedText(data.text);
}

function processExtractedText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    // Heuristic: 1st line = Title, 2nd line = Composer
    return {
        title: lines[0] || "",
        composer: lines[1] || "",
        rawText: text
    };
}

// --- TEST RUNNER ---
async function runTest() {
    // Check if a file path is provided as an argument
    const filePath = process.argv[2];
    
    if (!filePath) {
        console.error("Usage: node test-ocr.js <path-to-file>");
        process.exit(1);
    }

    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }

    const ext = path.extname(filePath).toLowerCase();
    
    try {
        let result;
        if (ext === '.pdf') {
            result = await extractMetadataFromPdf(filePath);
        } else if (['.jpg', '.jpeg', '.png', '.bmp'].includes(ext)) {
            result = await extractMetadataFromImage(filePath);
        } else {
            console.error("Unsupported file type. Please use .pdf, .jpg, .png, or .bmp");
            process.exit(1);
        }
        
        console.log("\n--- OCR RESULTS ---");
        console.log("Title:", result.title);
        console.log("Composer:", result.composer);
        console.log("-------------------");
        console.log("Raw Text Preview (first 500 chars):");
        console.log(result.rawText.substring(0, 500));
        
    } catch (error) {
        console.error("OCR Failed:", error);
    }
}

runTest();
