export function extractReplyBody(payload) {
  const extract = (part) => {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf8');
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      const html = Buffer.from(part.body.data, 'base64').toString('utf8');
      return html.replace(/<[^>]+>/g, '');
    } else if (part.parts) {
      for (const sub of part.parts) {
        const nested = extract(sub);
        if (nested) return nested;
      }
    }
    return '';
  };

  return extract(payload) || '[No readable text body]';
}
