import type { AiOperation } from './operations.ts'

/** Fails typecheck if an AiOperation type is added without a production-path fixture. */
export const PRODUCTION_PATH_FIXTURES: { [K in AiOperation['type']]: Extract<AiOperation, { type: K }> } = {
  replace_content: { type: 'replace_content', content: '<p>ReplacedDoc</p>' },
  insert_at_end: { type: 'insert_at_end', content: '<p>Tail</p>' },
  insert_at_cursor: { type: 'insert_at_cursor', content: '<p>CursorInsert</p>' },
  insert_after_paragraph: { type: 'insert_after_paragraph', paragraph_index: 0, content: '<p>After</p>' },
  replace_paragraph: { type: 'replace_paragraph', paragraph_index: 0, content: '<p>ReplacedBlock</p>' },
  delete_paragraph: { type: 'delete_paragraph', paragraph_index: 1 },
  replace_selection: { type: 'replace_selection', content: 'XXXXX' },
  set_heading: { type: 'set_heading', level: 2 },
  set_bold: { type: 'set_bold' },
  set_italic: { type: 'set_italic' },
  set_underline: { type: 'set_underline' },
  set_strikethrough: { type: 'set_strikethrough' },
  set_highlight: { type: 'set_highlight' },
  set_link: { type: 'set_link', href: 'https://example.com' },
  set_align: { type: 'set_align', alignment: 'center' },
  set_font_family: { type: 'set_font_family', family: 'Arial' },
  set_font_size: { type: 'set_font_size', size: '18pt' },
  set_color: { type: 'set_color', color: '#ff0000' },
  insert_table: { type: 'insert_table', rows: 2, cols: 2 },
  insert_list: { type: 'insert_list', list_type: 'ordered', items: ['one', 'two'] },
  insert_horizontal_rule: { type: 'insert_horizontal_rule' },
  insert_code_block: { type: 'insert_code_block', content: 'print(1)', language: 'python' },
  insert_blockquote: { type: 'insert_blockquote', content: 'quoted' },
  insert_image: { type: 'insert_image', src: 'https://example.com/a.png', alt: 'pic' },
}
