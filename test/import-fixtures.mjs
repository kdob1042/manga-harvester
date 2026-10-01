import {zipSync} from 'fflate';
import {png} from './runtime.mjs';
export const cbz=zipSync({'photos/one.png':png,'photos/two.png':png,'metadata.txt':new TextEncoder().encode('not an image')});
// Self-authored tiny two-image PDF; nothing copyrighted or network-loaded.
export function pdfFixture(){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 250] /Resources << >> /Contents 4 0 R >>',
  '<< /Length 28 >>\nstream\n0.2 0.4 0.6 rg 0 0 200 250 re f\nendstream',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 250] /Resources << >> /Contents 6 0 R >>',
  '<< /Length 28 >>\nstream\n0.6 0.4 0.2 rg 0 0 200 250 re f\nendstream'];
 let body='%PDF-1.7\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${o}\nendobj\n`;});
 const start=Buffer.byteLength(body);body+=`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
 return Buffer.from(body);
}
