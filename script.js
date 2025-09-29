

async function loadExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        // cellDates: true ajuda a preservar células de data como Date
        const workbook = XLSX.read(data, { type: "array", cellDates: true, raw: false, dateNF: 'dd/mm/yyyy' });

        // Pega a primeira aba
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Converte para JSON
        const json = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

        resolve({ json, workbook, worksheet });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

let ingredientes = []; // dataset carregado da planilhas
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

function canonicalUnit(raw) {
  if (!raw) return 'UN';
  const key = String(raw).trim().toLowerCase().replace(/\./g, '');
  return UNIT_MAP[key] || (raw.toString().trim().toUpperCase() || 'UN');
}

function parseNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/\./g,'').replace(',', '.').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function normalizeUnitForSum(qt, unit) {
  const u = (unit || '').toUpperCase();
  if (u === 'L') return { quantidade: qt * 1000, unidade: 'ML' };
  if (u === 'ML') return { quantidade: qt, unidade: 'ML' };
  if (u === 'KG') return { quantidade: qt * 1000, unidade: 'G' };
  if (u === 'G') return { quantidade: qt, unidade: 'G' };
  return { quantidade: qt, unidade: u || 'UN' };
}

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



// Detecta colunas sem depender de maiúsculas exatas
function detectColumnMapping(headers) {
  const map = {};
  headers.forEach(h => {
    const low = String(h).toLowerCase();
    if (low.includes('data')) map.data = h;
    else if (low.includes('receita') || low.includes('aula') || low.includes('uc')) map.receita = h;
    else if (low.includes('insumo') || low.includes('ingred') || low.includes('produto') || low.includes('item')) map.insumo = h;
    else if (low.includes('qt') || low.includes('quant')) map.quantidade = h;
    else if (low.includes('und') || low.includes('unid') || low === 'um') map.unidade = h;
    else if (low.includes('tipo') || low.includes('setor') || low.includes('categoria')) map.tipo = h;
  });
  return map;
}

// Retorna data no formato ISO YYYY-MM-DD (seguros para new Date())
function formatDatePt(d) {
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const ano = d.getFullYear();
  return ` ${ano}-${mes}-${dia}`; // YYYY-MM-DD
}

// Extrai data de várias formas (Date, número serial do Excel ou string)
function extractDate(rawDate) {
  if (!rawDate && rawDate !== 0) return null;

  // Se já for Date
  if (rawDate instanceof Date && !isNaN(rawDate)) {
    return formatDatePt(rawDate);
  }

  // Se for número (serial Excel)
  if (typeof rawDate === 'number') {
    // Excel serial -> JavaScript Date
    // Excel epoch = 1899-12-30
    const d = new Date(Math.round((rawDate - 25569) * 86400 * 1000));
    if (!isNaN(d.getTime())) return formatDatePt(d);
    return null;
  }

  // Se for string: tentar parse inteligente
  const s = String(rawDate).trim();
  if (!s) return null;

  // tentar detectar formatos dd/mm/yyyy ou dd-mm-yyyy primeiro
  const dm = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dm) {
    let dd = dm[1].padStart(2,'0');
    let mm = dm[2].padStart(2,'0');
    let yyyy = dm[3].length === 2 ? ('20' + dm[3]) : dm[3];
    const parsed = new Date(`${yyyy}-${mm}-${dd}`);
    if (!isNaN(parsed.getTime())) return formatDatePt(parsed);
  }

  // fallback para new Date (ISO ou outros)
  const tryD = new Date(s);
  if (!isNaN(tryD.getTime())) return formatDatePt(tryD);

  return null;
}

// ---------------- Processamento ----------------

function processSheetJson(jsonRows) {
  if (!jsonRows || jsonRows.length === 0) {
    ingredientes = [];
    return;
  }

  const headers = Object.keys(jsonRows[0] || {});
  const colMap = detectColumnMapping(headers);

  ingredientes = jsonRows.map(row => {
    // uso fallback para nomes comuns caso detect não ache
    const dataRaw = (colMap.data ? row[colMap.data] : (row['DATA'] || row['Data'] || row['data'])) || '';
    const receitaRaw = (colMap.receita ? row[colMap.receita] : (row['AULA'] || row['RECEITA'] || row['Aula'] || row['Receita'])) || '';
    const insumoRaw = (colMap.insumo ? row[colMap.insumo] : (row['INSUMO'] || row['Insumo'] || row['insumo'])) || '';
    const qtRaw = (colMap.quantidade ? row[colMap.quantidade] : (row['QUANT.'] || row['QUANT'] || row['Quantidade'])) || '';
    const undRaw = (colMap.unidade ? row[colMap.unidade] : (row['UND'] || row['Und'] || row['un'])) || '';
    const tipoRaw = (colMap.tipo ? row[colMap.tipo] : (row['TIPO'] || row['Tipo'] || '')) || '';

    if (!insumoRaw || !receitaRaw) return null;

    return {
      data: extractDate(dataRaw), // retorna YYYY-MM-DD ou null
      receita: String(receitaRaw).trim(),
      insumo: String(insumoRaw).trim(),
      qt: parseNumber(qtRaw),
      um: canonicalUnit(undRaw),
       tipo: String(tipoRaw)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
    };
  }).filter(Boolean);
}

function groupByDataReceita(filtered) {
  const map = {};
  filtered.forEach(item => {
    const d = item.data || 'Sem data';
    if (!map[d]) map[d] = {};
    const r = item.receita || 'Sem receita';
    if (!map[d][r]) map[d][r] = [];
    map[d][r].push(item);
  });
  return map;
}
function renderCards(filtered) {
  const container = document.getElementById('blocosAulas');
  container.innerHTML = '';
  const grouped = groupByDataReceita(filtered);
  const datas = Object.keys(grouped).sort();

  datas.forEach(data => {
    const aulaCard = document.createElement('div');
    aulaCard.className = 'aulaCard';

    const header = document.createElement('div');
    header.className = 'aulaHeader';
    const title = document.createElement('div');
    title.className = 'aulaTitle';
    const receitas = Object.keys(grouped[data]);
    title.textContent = `Data ${data} — ${receitas.length} receitas`;
    header.appendChild(title);
    aulaCard.appendChild(header);

    const receitasList = document.createElement('div');
    receitasList.className = 'receitasList';

    receitas.forEach(receitaName => {
      const insumos = grouped[data][receitaName];
      const receitaRow = document.createElement('div');
      receitaRow.className = 'receitaRow';

      const main = document.createElement('div');
      main.className = 'receitaMain';

      const nome = document.createElement('div');
      nome.className = 'receitaName';
      nome.textContent = receitaName;

      const preview = document.createElement('div');
      preview.className = 'insumosPreview';
      preview.textContent = insumos.map(i => `${i.insumo} (${i.qt}${i.um})`).slice(0,3).join(' • ');

      main.appendChild(nome);
      main.appendChild(preview);

      const controls = document.createElement('div');
      controls.className = 'controls';

      // botão Ler mais
      const lerMaisBtn = document.createElement('button');
      lerMaisBtn.textContent = 'Ler mais';
      lerMaisBtn.className = 'btn btn-outline';
      lerMaisBtn.style.padding = '6px 10px';

      controls.appendChild(lerMaisBtn);

      receitaRow.appendChild(main);
      receitaRow.appendChild(controls);

      const full = document.createElement('div');
      full.className = 'insumosFull hidden';

      // tipos continuam aparecendo aqui, dentro do expandido
      insumos.forEach(it => {
        const l = document.createElement('div');
        l.textContent = `${it.insumo} — ${it.qt} ${it.um} (${it.tipo})`;
        full.appendChild(l);
      });

      lerMaisBtn.addEventListener('click', () => {
        full.classList.toggle('hidden');
        lerMaisBtn.textContent = full.classList.contains('hidden') ? 'Ler mais' : 'Fechar';
        if (!full.classList.contains('hidden')) {
          full.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });

      receitasList.appendChild(receitaRow);
      receitasList.appendChild(full);
    });

    aulaCard.appendChild(receitasList);
    container.appendChild(aulaCard);
  });
}
function applyFilters() {
  // Lê o select e normaliza para minúsculas sem acentos
  const tipoSelect = document.getElementById('tipo');
  const tipo = tipoSelect ? tipoSelect.value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : 'todos';

  const buscar = document.getElementById('searchInput').value.trim().toLowerCase();
  const di = document.getElementById('dataInicio').value;
  const df = document.getElementById('dataFim').value;

  const start = di ? new Date(di) : new Date(-8640000000000000);
  const end = df ? new Date(df) : new Date(8640000000000000);

  let filtrados = ingredientes.filter(i => {
    const tipoNormalizado = (i.tipo || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const condTipo = (tipo === 'todos') || tipoNormalizado === tipo;
    const condBusca = !buscar || i.insumo.toLowerCase().includes(buscar) || i.receita.toLowerCase().includes(buscar);
    const condData = i.data ? (new Date(i.data) >= start && new Date(i.data) <= end) : true;
    return condTipo && condBusca && condData;
  });

  return filtrados;
}


function consolidateForResumo(items) {
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

  const lista = Object.values(map).map(item => {
    if (item.unidade === 'ML' && item.quantidade >= 1000) {
      return { ...item, quantidade: parseFloat((item.quantidade/1000).toFixed(3)), unidade: 'L' };
    }
    if (item.unidade === 'G' && item.quantidade >= 1000) {
      return { ...item, quantidade: parseFloat((item.quantidade/1000).toFixed(3)), unidade: 'KG' };
    }
    return item;
  });

  lista.sort((a,b) => a.especificacao.localeCompare(b.especificacao, 'pt-BR'));
  return lista;
}

function renderResumo(filtrados) {
  const dados = filtrados.map(i => ({ insumo: i.insumo, qt: i.qt, um: i.um }));
  const consolidado = consolidateForResumo(dados);
  ultimoResumo = consolidado;

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

  document.getElementById('blocosAulas').appendChild(resumoDiv);
  document.getElementById('exportCsvBtn').style.display = 'inline-block';
}

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

// ---------------- eventos e inicialização ----------------

document.addEventListener('DOMContentLoaded', () => {
  // Filtrar
  const filtrarBtn = document.getElementById('filtrarBtn');
  if (filtrarBtn) {
    filtrarBtn.addEventListener('click', () => {
      const filtrados = applyFilters();
      renderCards(filtrados);
      document.querySelectorAll('.resumo').forEach(e=>e.remove());
      const exportBtn = document.getElementById('exportCsvBtn');
      if (exportBtn) exportBtn.style.display = 'none';
    });
  }

  // Gerar resumo
  const gerarResumoBtn = document.getElementById('gerarResumoBtn');
  if (gerarResumoBtn) {
    gerarResumoBtn.addEventListener('click', () => {
      const filtrados = applyFilters();
      renderResumo(filtrados);
      const el = document.querySelector('.resumo');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // Exportar resumo CSV
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', exportResumoToCSV);
    // esconder até ter resumo
    exportCsvBtn.style.display = 'none';
  }

  // Input de arquivo
  const excelInput = document.getElementById('excelInput');
  if (excelInput) {
    excelInput.addEventListener('change', async (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      try {
        const { json } = await loadExcelFile(f);
        processSheetJson(json);
        const filtrados = applyFilters();
        renderCards(filtrados);
        document.querySelectorAll('.resumo').forEach(e=>e.remove());
        const exportBtn = document.getElementById('exportCsvBtn');
        if (exportBtn) exportBtn.style.display = 'none';

        const datasUnicas = [...new Set(ingredientes.map(i => i.data).filter(Boolean))].sort();
        alert(`Planilha importada: ${ingredientes.length} linhas processadas. Datas detectadas: ${datasUnicas.length}`);
      } catch (err) {
        console.error('Erro ao processar planilha:', err);
        alert('Erro ao processar a planilha. Verifique o arquivo.');
      }
    });
  }

  // cursos (localStorage)
  carregarListaCursos();

  const btnSalvar = document.getElementById("btnSalvarCurso");
  if (btnSalvar) btnSalvar.addEventListener("click", () => {
    const nome = prompt("Digite um nome para este curso:");
    salvarCurso(nome);
  });

  const btnExcluir = document.getElementById("btnExcluirCurso");
  if (btnExcluir) btnExcluir.addEventListener("click", () => {
    const select = document.getElementById("cursosSalvos");
    if (select && select.value) excluirCurso(select.value);
  });

  const sel = document.getElementById("cursosSalvos");
  if (sel) sel.addEventListener("change", (e) => {
    if (e.target.value) carregarCurso(e.target.value);
  });
});

// Funções de persistência de cursos (mantive suas implementações)
function salvarCurso(nome) {
  if (!nome) {
    alert("Digite um nome para salvar o curso.");
    return;
  }
  localStorage.setItem("curso_" + nome, JSON.stringify(ingredientes));
  carregarListaCursos();
  alert("Curso salvo com sucesso!");
}

function carregarCurso(nome) {
  const data = localStorage.getItem("curso_" + nome);
  if (!data) return;
  ingredientes = JSON.parse(data);
  const filtrados = applyFilters();
  renderCards(filtrados);
  document.querySelectorAll('.resumo').forEach(e=>e.remove());
  const exportBtn = document.getElementById('exportCsvBtn');
  if (exportBtn) exportBtn.style.display = 'none';
}

function excluirCurso(nome) {
  localStorage.removeItem("curso_" + nome);
  carregarListaCursos();
  alert("Curso excluído com sucesso!");
}

function carregarListaCursos() {
  const select = document.getElementById("cursosSalvos");
  if (!select) return;
  select.innerHTML = "";
  for (let i=0; i<localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith("curso_")) {
      const option = document.createElement("option");
      option.value = key.replace("curso_","");
      option.textContent = key.replace("curso_","");
      select.appendChild(option);
    }
  }
}
// Função para salvar curso no localStorage
function salvarCurso(nome) {
  if (!nome) {
    alert("Digite um nome para salvar o curso.");
    return;
  }
  localStorage.setItem("curso_" + nome, JSON.stringify(ingredientes));
  carregarListaCursos();
  alert("Curso salvo com sucesso!");
}

// Função para carregar curso do localStorage
function carregarCurso(nome) {
  const data = localStorage.getItem("curso_" + nome);
  if (!data) return;
  ingredientes = JSON.parse(data);
  const filtrados = applyFilters();
  renderCards(filtrados);
  document.querySelectorAll('.resumo').forEach(e=>e.remove());
  document.getElementById('exportCsvBtn').style.display = 'none';
}



// Atualiza lista de cursos salvos
function carregarListaCursos() {
  const select = document.getElementById("cursosSalvos");
  if (!select) return;
  select.innerHTML = "";
  for (let i=0; i<localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith("curso_")) {
      const option = document.createElement("option");
      option.value = key.replace("curso_","");
      option.textContent = key.replace("curso_","");
      select.appendChild(option);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  carregarListaCursos();



  document.getElementById("btnExcluirCurso").addEventListener("click", () => {
    const select = document.getElementById("cursosSalvos");
    if (select.value) excluirCurso(select.value);
  });

  document.getElementById("cursosSalvos").addEventListener("change", (e) => {
    if (e.target.value) carregarCurso(e.target.value);
  });
});



