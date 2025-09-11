// script.js - versão final adaptada para sua planilha
// Requer: xlsx.full.min.js (SheetJS) incluído no HTML

let ingredientes = []; // dataset carregado da planilha
let ultimoResumo = null; // guarda o resumo gerado (para export)

// mapeamento de variantes de unidades -> canonico
const UNIT_MAP = {
  'kg': 'KG', 'kilo': 'KG', 'quilogram': 'KG', 'kgs': 'KG', 'kg.': 'KG',
  'g': 'G', 'gram': 'G', 'gr': 'G',
  'l': 'L', 'lt': 'L', 'litro': 'L',
  'ml': 'ML', 'mililitro': 'ML', 'cc': 'ML',
  'un': 'UN', 'un.': 'UN', 'und': 'UN', 'unid': 'UN',
  'cx': 'CX', 'caixa': 'CX',
  'pct': 'PCT', 'pacote': 'PCT',
  'mc': 'MC', 'fr': 'FR'
};

// util: padroniza unidade encontrada -> canonica
function canonicalUnit(raw) {
  if (!raw) return 'UN';
  const key = String(raw).trim().toLowerCase().replace(/\./g, '');
  return UNIT_MAP[key] || (raw.toString().trim().toUpperCase() || 'UN');
}

// util: normaliza número extraído (tratando vírgula)
function parseNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/\./g,'').replace(',', '.').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// converte unidades para base pequena para somar (G e ML)
function normalizeUnitForSum(qt, unit) {
  const u = unit.toUpperCase();
  if (u === 'L') return { quantidade: qt * 1000, unidade: 'ML' };
  if (u === 'ML') return { quantidade: qt, unidade: 'ML' };
  if (u === 'KG') return { quantidade: qt * 1000, unidade: 'G' };
  if (u === 'G') return { quantidade: qt, unidade: 'G' };
  // UN, CX, PCT, etc - mantem como está
  return { quantidade: qt, unidade: u };
}

// gera código simples: ES + 3 letras (sem acento) + unidade
function gerarCodigo(especificacao, unidade) {
  const base = especificacao
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .substring(0,3)
    .toUpperCase();
  const u = (unidade||'').toString().replace(/[^A-Z0-9]/ig,'').toUpperCase();
  return `ES${base}${u}`;
}

// ------------------ leitura / mapeamento da planilha ------------------
function detectColumnMapping(headers) {
  // headers: array de títulos (originais)
  const map = {};
  headers.forEach(h => {
    const low = String(h).toLowerCase();
    if (low.includes('aula')) map.aula = h;
    else if (low.includes('receit')) map.receita = h;
    else if (low.includes('insum') || low.includes('ingred') || low.includes('item') || low.includes('produto')) map.insumo = h;
    else if (low.includes('qt') || low.includes('quant')) map.quantidade = h;
    else if (low.includes('und') || low.includes('unid') || low === 'um') map.unidade = h;
    else if (low.includes('tipo') || low.includes('setor') || low.includes('categoria')) map.tipo = h;
    // aceita 'CODIGO MXM' mas não é obrigatório
  });
  return map;
}

function extractAulaNumber(rawAula) {
  if (rawAula === null || rawAula === undefined) return 0;
  const s = String(rawAula).trim();
  // tenta extrair dígito(s)
  const m = s.match(/(\d+)/);
  if (m) return parseInt(m[0], 10);
  // fallback: parseInt direto
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

function loadExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const firstSheet = wb.SheetNames[0];
        const sheet = wb.Sheets[firstSheet];
        const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        resolve({ json, sheetName: firstSheet });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// processa json da planilha e popula ingredientes[]
function processSheetJson(jsonRows) {
  if (!Array.isArray(jsonRows) || jsonRows.length === 0) {
    ingredientes = [];
    return;
  }
  const headers = Object.keys(jsonRows[0]);
  const colMap = detectColumnMapping(headers);

  const result = [];
  jsonRows.forEach(row => {
    // tenta mapear por colMap; se não existir, tenta os nomes padrão
    const aulaRaw = row[colMap.aula] ?? row['AULA'] ?? row['aula'] ?? row['Aula'];
    const receitaRaw = row[colMap.receita] ?? row['RECEITA'] ?? row['Receita'] ?? row['receita'];
    const insumoRaw = row[colMap.insumo] ?? row['INSUMO'] ?? row['Insumo'] ?? row['insumo'];
    const qtRaw = row[colMap.quantidade] ?? row['QT.'] ?? row['Quantidade'] ?? row['QT'] ?? row['qt'];
    const undRaw = row[colMap.unidade] ?? row['UND'] ?? row['UND.'] ?? row['Unidade'] ?? '';
    const tipoRaw = row[colMap.tipo] ?? row['TIPO'] ?? row['Tipo'] ?? '';

    if (!insumoRaw || !receitaRaw) return; // ignora linhas inválidas

    result.push({
      aula: extractAulaNumber(aulaRaw),
      receita: String(receitaRaw).trim(),
      insumo: String(insumoRaw).trim(),
      qt: parseNumber(qtRaw),
      um: canonicalUnit(undRaw),
      tipo: String((tipoRaw || '')).trim().toLowerCase() || 'mercearia'
    });
  });

  ingredientes = result;
}

// ------------------ UI / renders ------------------
function updateAulaSelects() {
  const aulas = Array.from(new Set(ingredientes.map(i => i.aula).filter(n => n && !isNaN(n)))).sort((a,b)=>a-b);
  const inicio = document.getElementById('aulaInicio');
  const fim = document.getElementById('aulaFim');

  // limpa exceto a opção "todos"
  inicio.innerHTML = '<option value="todos">Todos</option>';
  fim.innerHTML = '<option value="todos">Todos</option>';

  aulas.forEach(a => {
    const o1 = document.createElement('option');
    o1.value = String(a);
    o1.textContent = `Aula ${a}`;
    const o2 = o1.cloneNode(true);
    inicio.appendChild(o1);
    fim.appendChild(o2);
  });
}

function groupByAulaReceita(filtered) {
  // Retorna estrutura: { aulaNum: { receitaNome: [itens...] } }
  const map = {};
  filtered.forEach(item => {
    const a = item.aula || 0;
    if (!map[a]) map[a] = {};
    const r = item.receita || 'Sem receita';
    if (!map[a][r]) map[a][r] = [];
    map[a][r].push(item);
  });
  return map;
}

function renderCards(filtered) {
  const container = document.getElementById('blocosAulas');
  container.innerHTML = '';
  const grouped = groupByAulaReceita(filtered);
  const aulas = Object.keys(grouped).sort((a,b)=>a-b);

  if (aulas.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:#666">Nenhuma aula encontrada para o filtro.</p>';
    return;
  }

  aulas.forEach(aula => {
    const aulaCard = document.createElement('div');
    aulaCard.className = 'aulaCard';

    const header = document.createElement('div');
    header.className = 'aulaHeader';
    const title = document.createElement('div');
    title.className = 'aulaTitle';
    title.textContent = `Aula ${aula} — ${Object.keys(grouped[aula]).length} receitas`;
    header.appendChild(title);
    aulaCard.appendChild(header);

    const receitasList = document.createElement('div');
    receitasList.className = 'receitasList';

    Object.keys(grouped[aula]).forEach(receitaName => {
      const insumos = grouped[aula][receitaName];
      const receitaRow = document.createElement('div');
      receitaRow.className = 'receitaRow';

      const main = document.createElement('div');
      main.className = 'receitaMain';

      const nome = document.createElement('div');
      nome.className = 'receitaName';
      nome.textContent = receitaName;

      const preview = document.createElement('div');
      preview.className = 'insumosPreview';
      // mostra até 3 insumos em preview
      const previewItems = insumos.slice(0,3).map(i => `${i.insumo} (${i.qt}${i.um})`).join(' • ');
      preview.textContent = previewItems + (insumos.length > 3 ? `  • ... (+${insumos.length-3})` : '');

      main.appendChild(nome);
      main.appendChild(preview);

      const controls = document.createElement('div');
      controls.className = 'controls';

      const badge = document.createElement('div');
      const tipo = (insumos[0].tipo || 'unknown').toLowerCase();
      badge.className = `badge ${tipo || 'unknown'}`;
      badge.textContent = tipo || 'UNKNOWN';

      const lerMaisBtn = document.createElement('button');
      lerMaisBtn.textContent = 'Ler mais';
      lerMaisBtn.style.padding = '6px 10px';
      lerMaisBtn.style.fontSize = '13px';

      controls.appendChild(badge);
      controls.appendChild(lerMaisBtn);

      receitaRow.appendChild(main);
      receitaRow.appendChild(controls);

      // conteudo expansível com a lista completa de insumos
      const full = document.createElement('div');
      full.className = 'insumosFull hidden';
      // monta HTML da lista
      const list = document.createElement('div');
      insumos.forEach(it => {
        const l = document.createElement('div');
        l.textContent = `${it.insumo} — ${it.qt} ${it.um} (${it.tipo})`;
        list.appendChild(l);
      });
      full.appendChild(list);

      // toggle ler mais
      lerMaisBtn.addEventListener('click', () => {
        full.classList.toggle('hidden');
        lerMaisBtn.textContent = full.classList.contains('hidden') ? 'Ler mais' : 'Fechar';
      });

      receitasList.appendChild(receitaRow);
      receitasList.appendChild(full);
    });

    aulaCard.appendChild(receitasList);
    container.appendChild(aulaCard);
  });
}

// aplica filtros: tipo, aulaInicio/aulaFim, busca
function applyFilters() {
  const tipo = document.getElementById('tipo').value;
  const buscar = document.getElementById('searchInput').value.trim().toLowerCase();
  const ai = document.getElementById('aulaInicio').value;
  const af = document.getElementById('aulaFim').value;
  const aInicio = ai === 'todos' ? -Infinity : parseInt(ai);
  const aFim = af === 'todos' ? Infinity : parseInt(af);

  const filtrados = ingredientes.filter(i => {
    const condAula = i.aula >= aInicio && i.aula <= aFim;
    const condTipo = tipo === 'todos' ? true : (i.tipo && i.tipo.toLowerCase() === tipo.toLowerCase());
    const condBusca = !buscar || (i.insumo && i.insumo.toLowerCase().includes(buscar)) || (i.receita && i.receita.toLowerCase().includes(buscar));
    return condAula && condTipo && condBusca;
  });
  return filtrados;
}

// ------------------ resumo consolidado ------------------
function consolidateForResumo(items) {
  // items: array { insumo, qt, um }
  // consolidar por insumo + unidade base (G ou ML ou UN etc)
  const map = {};
  items.forEach(it => {
    const esp = (it.insumo || '').trim();
    const unitCanon = canonicalUnit(it.um);
    const parsed = parseNumber(it.qt);
    const normalized = normalizeUnitForSum(parsed, unitCanon);
    const key = `${esp.toLowerCase()}@@${normalized.unidade}`;

    if (!map[key]) map[key] = { especificacao: esp, quantidade: 0, unidade: normalized.unidade };
    map[key].quantidade += normalized.quantidade;
  });

  // transformar valores grandes em L/KG se aplicavel
  const lista = Object.values(map).map(item => {
    if (item.unidade === 'ML' && item.quantidade >= 1000) {
      return { ...item, quantidade: parseFloat((item.quantidade/1000).toFixed(3)), unidade: 'L' };
    }
    if (item.unidade === 'G' && item.quantidade >= 1000) {
      return { ...item, quantidade: parseFloat((item.quantidade/1000).toFixed(3)), unidade: 'KG' };
    }
    return item;
  });

  // ordenar por especificação
  lista.sort((a,b) => a.especificacao.localeCompare(b.especificacao, 'pt-BR'));
  return lista;
}

function renderResumo(filtrados) {
  // consolida todos os insumos das linhas filtradas
  const dados = filtrados.map(i => ({ insumo: i.insumo, qt: i.qt, um: i.um }));
  const consolidado = consolidateForResumo(dados);
  ultimoResumo = consolidado; // salva para export

  // renderizar
  // remove resumos antigos
  document.querySelectorAll('.resumo').forEach(e => e.remove());

  const resumoDiv = document.createElement('div');
  resumoDiv.className = 'resumo';

  const title = document.createElement('h2');
  title.textContent = 'Resumo Consolidado';
  title.style.marginTop = '0';
  resumoDiv.appendChild(title);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Quantidade</th><th>Unidade</th><th>Código</th><th>Especificação</th></tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');

  consolidado.forEach(item => {
    const tr = document.createElement('tr');
    const codigo = gerarCodigo(item.especificacao, item.unidade);
    tr.innerHTML = `<td>${item.quantidade}</td><td>${item.unidade}</td><td>${codigo}</td><td>${item.especificacao}</td>`;
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  resumoDiv.appendChild(table);

  // append after main container
  document.getElementById('blocosAulas').appendChild(resumoDiv);

  // mostrar botão export
  document.getElementById('exportCsvBtn').style.display = 'inline-block';
}

// export CSV simples
function exportResumoToCSV() {
  if (!ultimoResumo || ultimoResumo.length === 0) {
    alert('Nenhum resumo para exportar. Gere o resumo primeiro.');
    return;
  }
  const rows = [['Quantidade','Unidade','Codigo','Especificacao']];
  ultimoResumo.forEach(r => rows.push([r.quantidade, r.unidade, gerarCodigo(r.especificacao, r.unidade), r.especificacao]));
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'resumo_consolidado.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ------------------ eventos UI ------------------
document.addEventListener('DOMContentLoaded', () => {
  // eventos
  document.getElementById('filtrarBtn').addEventListener('click', () => {
    const filtrados = applyFilters();
    renderCards(filtrados);
    // remove resumo antigo quando filtrar
    document.querySelectorAll('.resumo').forEach(e=>e.remove());
    document.getElementById('exportCsvBtn').style.display = 'none';
  });

  document.getElementById('gerarResumoBtn').addEventListener('click', () => {
    const filtrados = applyFilters();
    renderResumo(filtrados);
    // rolar para o resumo
    const el = document.querySelector('.resumo');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  });

  document.getElementById('exportCsvBtn').addEventListener('click', exportResumoToCSV);

  // upload excel
  const excelInput = document.getElementById('excelInput');
  excelInput.addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      const { json } = await loadExcelFile(f);
      processSheetJson(json);
      // atualiza selects e render
      updateAulaSelects();
      const filtrados = applyFilters();
      renderCards(filtrados);
      // limpa resumo anterior
      document.querySelectorAll('.resumo').forEach(e=>e.remove());
      document.getElementById('exportCsvBtn').style.display = 'none';
      alert(`Planilha importada: ${ingredientes.length} linhas processadas. Aulas detectadas: ${[...new Set(ingredientes.map(i=>i.aula))].sort((a,b)=>a-b).length}`);
    } catch (err) {
      console.error(err);
      alert('Erro ao processar a planilha. Verifique o arquivo.');
    }
  });

  // inicia view se já tiver dados (ex: dataset de exemplo)
  // renderCards(ingredientes);
});