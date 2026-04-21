import fs from 'node:fs';
import path from 'node:path';

const inputPath = process.argv[2] || path.join(process.cwd(), 'data.json');
const outputPath = process.argv[3] || path.join(process.cwd(), 'supabase-import.sql');
const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const leads = Array.isArray(payload.leads) ? payload.leads : [];

function sql(value) {
  if (value === null || value === undefined || value === '') return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

const columns = [
  'id','source_account','date_received','sender_name','sender_email','sender_phone','subject','source_rule','source_platform','matter_type','priority','status','notes','draft_reply','raw_preview','reviewed_at','location','opposing_party','next_action'
];

const values = leads.map((lead) => `(${columns.map((column) => sql(lead[column])).join(', ')})`).join(',\n');
const updates = columns.filter((column) => column !== 'id').map((column) => `  ${column} = excluded.${column}`).join(',\n');
const output = `insert into public.leads (${columns.join(', ')})\nvalues\n${values}\non conflict (id) do update set\n${updates},\n  updated_at = timezone('utc', now());\n`;

fs.writeFileSync(outputPath, output);
console.log(`Wrote ${leads.length} lead rows to ${outputPath}`);
