// Synthetic PDFs generated from source; no real patient files or external tools.
export function syntheticDigitalPdf(pages:string[][],options:{unicode?:boolean;imageOnly?:boolean;javascript?:boolean;attachment?:boolean;form?:boolean;brokenPage?:boolean}={}):Buffer{
  const objects:string[]=[];
  const add=(body:string)=>{objects.push(body);return objects.length;};
  const stream=(text:string)=>`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const catalog=add(''),tree=add('');
  const mapping=new Map<string,number>();
  for(const lines of pages)for(const line of lines)for(const character of line)if(!mapping.has(character))mapping.set(character,mapping.size+1);
  let font:number;
  if(options.unicode){
    const cmap=`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /SyntheticUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${mapping.size} beginbfchar\n`+
      [...mapping].map(([character,id])=>`<${id.toString(16).padStart(4,'0')}> <${Buffer.from(character,'utf16le').swap16().toString('hex')}>`).join('\n')+'\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
    const toUnicode=add(stream(cmap));
    const descriptor=add('<< /Type /FontDescriptor /FontName /SyntheticUnicode /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>');
    const descendant=add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticUnicode /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 500 /CIDToGIDMap /Identity >>`);
    font=add(`<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticUnicode /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
  }else font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  let image=0;if(options.imageOnly)image=add('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream');
  const refs:number[]=[];
  for(const lines of pages){
    const content=options.imageOnly?'q 40 0 0 40 20 20 cm /Im1 Do Q':lines.length?'BT /F1 12 Tf 40 740 Td '+lines.map((line,index)=>`${index?'0 -18 Td ':''}<${options.unicode?[...line].map(c=>mapping.get(c)!.toString(16).padStart(4,'0')).join(''):Buffer.from(line,'latin1').toString('hex')}> Tj`).join('\n')+' ET':'q\nQ';
    const contents=add(stream(content));
    refs.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> ${image?`/XObject << /Im1 ${image} 0 R >>`:''} >> /Contents ${contents} 0 R >>`));
  }
  objects[tree-1]=`<< /Type /Pages /Kids [${options.brokenPage?'99999 0 R':refs.map(n=>`${n} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let extra='';
  if(options.javascript){const action=add('<< /S /JavaScript /JS (app.alert\\(synthetic\\)) >>');extra+=` /OpenAction ${action} 0 R`;}
  if(options.attachment){const content=add(stream('synthetic attachment; never extracted'));const file=add(`<< /Type /Filespec /F (synthetic.txt) /EF << /F ${content} 0 R >> >>`);extra+=` /Names << /EmbeddedFiles << /Names [(synthetic.txt) ${file} 0 R] >> >>`;}
  if(options.form){const widget=add('<< /Type /Annot /Subtype /Widget /FT /Tx /T (SyntheticField) /V (SyntheticFormValue) /Rect [0 0 10 10] >>');extra+=` /AcroForm << /Fields [${widget} 0 R] >>`;}
  objects[catalog-1]=`<< /Type /Catalog /Pages ${tree} 0 R${extra} >>`;
  let text='%PDF-1.7\n';const offsets=[0];
  for(const[index,body]of objects.entries()){offsets.push(Buffer.byteLength(text));text+=`${index+1} 0 obj\n${body}\nendobj\n`;}
  const xref=Buffer.byteLength(text);text+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1))text+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  return Buffer.from(text+`trailer\n<< /Size ${offsets.length} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
