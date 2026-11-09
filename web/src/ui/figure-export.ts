const svgNamespace = 'http://www.w3.org/2000/svg';

export function mountFigureExport() {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = element<HTMLDialogElement>('studio-export-dialog');
  const kind = element<HTMLSelectElement>('studio-export-kind');
  const format = element<HTMLSelectElement>('format');
  const preview = element<HTMLImageElement>('studio-figure-preview');
  const fileType = element<HTMLSelectElement>('studio-figure-format');
  const status = element('studio-figure-status');
  const simulator = new Set(['pwl', 'pwl-file', 'plecs']);
  let imageUrl = '';

  function renderFigure() {
    const source = document.querySelector<SVGSVGElement>('#plot')!;
    const copy = source.cloneNode(true) as SVGSVGElement;
    const dark = element<HTMLSelectElement>('studio-figure-theme').value === 'dark';
    const foreground = dark ? '#e4edf7' : '#142339';
    const signal = dark ? '#44e5ea' : '#1555aa';
    // The standalone figure cannot inherit editor CSS or document variables.
    const originals = source.querySelectorAll('*');
    copy.querySelectorAll('*').forEach((item, index) => {
      const style = getComputedStyle(originals[index]);
      for (const property of ['fill','stroke','stroke-width','stroke-dasharray','opacity','font-size','font-family']) {
        item.setAttribute(property, style.getPropertyValue(property));
      }
      if (item.tagName === 'text') item.setAttribute('fill', foreground);
      if (item.classList.contains('grid')) item.setAttribute('stroke', dark ? '#30415a' : '#d7e1eb');
      if (item.classList.contains('area')) item.setAttribute('fill', dark ? '#12354b' : '#ebf2fb');
      if (item.classList.contains('curve') || (item.tagName === 'path' && item.hasAttribute('clip-path'))) item.setAttribute('stroke', signal);
    });
    copy.querySelectorAll('.hit,[data-role="ramp-time"]').forEach(item=>item.remove());
    if (!element<HTMLInputElement>('studio-figure-cursors').checked) copy.querySelector('#measurement-layer')?.remove();
    if (!element<HTMLInputElement>('studio-figure-notes').checked) copy.querySelector('#annotation-layer')?.remove();
    const bounds = source.viewBox.baseVal;
    copy.setAttribute('xmlns',svgNamespace);
    copy.setAttribute('width',String(bounds.width));
    copy.setAttribute('height',String(bounds.height));
    const background = document.createElementNS(svgNamespace,'rect');
    background.setAttribute('width','100%'); background.setAttribute('height','100%');
    background.setAttribute('fill',dark ? '#0b1a2e' : 'white');
    copy.prepend(background);
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], {type:'image/svg+xml'}));
    preview.src = imageUrl;
    element<HTMLImageElement>('canvas-report').src = imageUrl;
  }

  function chooseKind() {
    const figure = kind.value === 'figure';
    element('studio-target-options').hidden = figure;
    element('studio-figure-options').hidden = !figure;
    status.textContent = '';
    if (figure) { renderFigure(); return; }
    for (const option of format.options) option.hidden = simulator.has(option.value) !== (kind.value === 'simulator');
    if (format.selectedOptions[0]?.hidden) {
      format.value = Array.from(format.options).find(option=>!option.hidden)!.value;
      format.dispatchEvent(new Event('change', {bubbles:true}));
    }
  }
  function download(url: string, extension: string) {
    const link = document.createElement('a');
    link.download = (element('wave-title').textContent?.trim() || 'waveform') + '.' + extension;
    link.href = url; link.click();
  }
  if (document.body?.ownerDocument) {
    let refresh = 0;
    const chart = document.querySelector<SVGSVGElement>('#plot')!;
    new MutationObserver(() => {
      cancelAnimationFrame(refresh);
      refresh = requestAnimationFrame(() => { if (chart.clientWidth) renderFigure(); });
    }).observe(chart,{childList:true,subtree:true});
    renderFigure();
  }
  kind.onchange = chooseKind;
  for (const id of ['studio-figure-theme','studio-figure-cursors','studio-figure-notes']) element(id).onchange = renderFigure;
  element('studio-export').onclick = () => {
    element('edit-tab').click();
    dialog.showModal();
    chooseKind();
  };
  dialog.onclose = () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = '';
  };
  element('studio-figure-download').onclick = async () => {
    try {
      await preview.decode();
      if (fileType.value === 'PDF (print)') { window.print(); return; }
      if (fileType.value === 'SVG') { download(imageUrl,'svg'); return; }
      const canvas = document.createElement('canvas');
      canvas.width = preview.naturalWidth * 2; canvas.height = preview.naturalHeight * 2;
      canvas.getContext('2d')!.drawImage(preview,0,0,canvas.width,canvas.height);
      canvas.toBlob(blob=>{
        if (!blob) { status.textContent='PNG export failed.'; return; }
        const url = URL.createObjectURL(blob);
        download(url,'png');
        setTimeout(()=>URL.revokeObjectURL(url),30000);
      },'image/png');
    } catch (error) { status.textContent = 'Could not export the figure. ' + String(error); }
  };
}
