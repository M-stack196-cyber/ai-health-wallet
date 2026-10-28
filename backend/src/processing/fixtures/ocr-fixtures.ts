import sharp from 'sharp';
export async function syntheticScan(text='SYNTHETIC REPORT FIRST',format:'png'|'jpeg'='png',rotated=false):Promise<Buffer>{
  const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500"><rect width="1200" height="500" fill="white"/><g font-family="DejaVu Sans" font-size="48" fill="black"><text x="60" y="100">${text}</text><text x="60" y="190">GLUCOSE 90 mg/dL</text><text x="60" y="280">SYNTHETIC TEST ONLY</text></g></svg>`);
  let image=sharp(svg);if(rotated)image=image.rotate(-90).withMetadata({orientation:6});
  return format==='png'?image.png().toBuffer():image.jpeg({quality:95}).toBuffer();
}
export async function syntheticScannedPdf(pages:({scan:string}|{text:string})[]):Promise<Buffer>{
  const objects:Buffer[]=[];const add=(value:string|Buffer)=>{objects.push(typeof value==='string'?Buffer.from(value):value);return objects.length;};
  add('');add('');const font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');const ids:number[]=[];
  for(const page of pages){
    let resources=`/Font << /F1 ${font} 0 R >>`,content:string;
    if('scan'in page){
      const image=await syntheticScan(page.scan,'jpeg');
      const id=add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 500 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`),image,Buffer.from('\nendstream')]));
      resources+=` /XObject << /Im ${id} 0 R >>`;content='q 600 0 0 250 0 0 cm /Im Do Q';
    }else content=`BT /F1 20 Tf 30 190 Td (${page.text.replace(/[()\\]/g,'\\$&')}) Tj ET`;
    const stream=add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    ids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 250] /Resources << ${resources} >> /Contents ${stream} 0 R >>`));
  }
  objects[0]=Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');objects[1]=Buffer.from(`<< /Type /Pages /Count ${ids.length} /Kids [${ids.map(id=>`${id} 0 R`).join(' ')}] >>`);
  const chunks=[Buffer.from('%PDF-1.7\n')],offsets=[0];let offset=chunks[0].length;
  objects.forEach((object,index)=>{offsets.push(offset);const bytes=Buffer.concat([Buffer.from(`${index+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]);chunks.push(bytes);offset+=bytes.length;});
  chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
