const { createWorker } = require('tesseract.js');
const path = require('path');

async function inspectTesseractOutput(imagePath) {
    const worker = await createWorker('eng');
    const ret = await worker.recognize(imagePath);
    await worker.terminate();

    console.log("--- Lines Analysis ---");
    ret.data.lines.forEach((line, index) => {
        const bbox = line.bbox;
        console.log(`Line ${index}: "${line.text.trim()}"`);
        console.log(`   BBox: x0=${bbox.x0}, y0=${bbox.y0}, x1=${bbox.x1}, y1=${bbox.y1}`);
        console.log(`   Confidence: ${line.confidence}`);
    });
}

// Use the uploaded image if available, or finding one
const testFile = process.argv[2] || "server/uploads/1767007095882-Agapi_pou_gines.pdf";
// Wait, the PDF OCR test script failed because PDF-parse didn't return text.
// We need an IMAGE to test Tesseract. 
// I'll assume the user might have an image or I can try to use a placeholder if the previous PDF was a scan.
// Since I can't easily convert PDF to image here server-side, I'll just explain the logic I will implement.

// Actually, I can write the logic directly into server/index.js if I am confident.
// Centered Text calculation: 
// Image Width (approx) can be inferred from the max x1 of lines or Tesseract might give page dimensions.
// ret.data.text usually doesn't give page width directly unless looking at 'ret.data.psm' or similar? 
// Actually 'ret.data' has 'imageColor', 'imageGrey', 'imageBinary'? No.
// But 'ret.data' often has 'box' or similar? No.

// I will assume standard A4 ratio if needed, or just relative positions.
// Title: Center X is roughly (x0 + x1) / 2. If this is close to PageWidth / 2.
// Composer: Right aligned -> x1 is close to PageWidth.

// Let's implement a 'Smart Metadata' function.
