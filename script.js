// Função principal que lê o arquivo Excel e transforma em JSON
async function loadExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); // Cria um leitor de arquivos do navegador

    reader.onload = (e) => { // Quando o arquivo terminar de carregar
      try {
        const data = new Uint8Array(e.target.result); // Converte o arquivo em array binário
        const workbook = XLSX.read(data, { // Lê o arquivo Excel usando a biblioteca XLSX
          type: "array",
          cellDates: true, // Mantém células de data no formato Date
          raw: false,
          dateNF: "dd/mm/yyyy" // Define formato de data padrão
        });

        // Escolhe a primeira aba da planilha que tenha mais de uma linha (para evitar abas vazias)
        let sheetName = workbook.SheetNames.find(name => {
          const ws = workbook.Sheets[name];
          const range = XLSX.utils.decode_range(ws["!ref"]);
          return range.e.r > 1;
        }) || workbook.SheetNames[0]; // Se não achar, usa a primeira

        // Obtém a aba selecionada
        const worksheet = workbook.Sheets[sheetName];

        // Converte a aba para JSON, mas no formato de matriz (header:1)
        const rows = XLSX.utils.sheet_to_json(worksheet, {
          defval: "", // Preenche células vazias com string vazia
          header: 1 // Retorna como array de arrays
        });

        // Detecta automaticamente a linha de cabeçalhos
        let headerRowIndex = rows.findIndex(r =>
          r.some(c =>
            String(c).toLowerCase().includes("receita") ||
            String(c).toLowerCase().includes("produto") ||
            String(c).toLowerCase().includes("insumo") ||
            String(c).toLowerCase().includes("quant") ||
            String(c).toLowerCase().includes("tipo")
          )
        );
        if (headerRowIndex === -1) headerRowIndex = 0; // Se não achar, assume a primeira linha

        const headers = rows[headerRowIndex].map(h => String(h).trim()); // Extrai os nomes das colunas
        const dataRows = rows.slice(headerRowIndex + 1).filter(r => r.some(v => v !== "")); // Remove linhas vazias

        // Cria objetos JSON associando cada valor ao nome da coluna
        const json = dataRows.map(r => {
          const obj = {};
          headers.forEach((h, i) => {
            obj[h] = r[i];
          });
          return obj;
        });

        resolve({ json, workbook, worksheet }); // Retorna os dados processados
      } catch (err) {
        reject(err); // Caso dê erro, rejeita a Promise
      }
    };

    reader.onerror = reject; // Caso falhe ao ler o arquivo
    reader.readAsArrayBuffer(file); // Lê o arquivo em formato binário
  });
}

// Variáveis globais
let ingredientes = []; // Onde ficam armazenados os itens carregados da planilha
let ultimoResumo = null; // Guarda o resumo consolidado

// Mapeamento de unidades para um formato padrão
const UNIT_MAP = {
  'kg': 'KG', 'kilo': 'KG', 'quilogram': 'KG', 'kgs': 'KG', 'kg.': 'KG',
  'l': 'L', 'lt': 'L', 'litro': 'L',
  'ml': 'ML', 'mililitro': 'ML', 'cc': 'ML',
  'un': 'UN', 'un.': 'UN', 'und': 'UN', 'unid': 'UN',
  'cx': 'CX', 'caixa': 'CX',
  'pct': 'PCT', 'pacote': 'PCT',
  'mc': 'MC', 'fr': 'FR'
};

// Converte uma unidade bruta para a forma padronizada (ex: “Kg” -> “KG”)
function canonicalUnit(raw) {
  if (!raw) return 'UN';
  const key = String(raw).trim().toLowerCase().replace(/\./g, '');
  return UNIT_MAP[key] || (raw.toString().trim().toUpperCase() || 'UN');
}

// Converte um valor numérico de string para número real (ex: “1,5” → 1.5)
function parseNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/\./g, '').replace(',', '.').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Normaliza unidades para facilitar somatório (ex: converte KG → G)
function normalizeUnitForSum(qt, unit) {
  const u = (unit || '').toUpperCase();
  if (u === 'L') return { quantidade: qt * 1000, unidade: 'ML' };
  if (u === 'ML') return { quantidade: qt, unidade: 'ML' };
  
  return { quantidade: qt, unidade: u || 'UN' };
}

// Detecta automaticamente quais colunas correspondem a cada campo importante
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

// Formata uma data JavaScript no formato “YYYY-MM-DD”
function formatDatePt(d) {
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const ano = d.getFullYear();
  return `${ano}-${mes}-${dia}`;
}

// Função que interpreta datas vindas da planilha (string, número ou Date)
function extractDate(rawDate) {
  if (!rawDate && rawDate !== 0) return null;
  if (rawDate instanceof Date && !isNaN(rawDate)) return formatDatePt(rawDate);
  if (typeof rawDate === 'number') {
    const d = new Date(Math.round((rawDate - 25569) * 86400 * 1000)); // Conversão de número serial Excel
    if (!isNaN(d.getTime())) return formatDatePt(d);
    return null;
  }
  const s = String(rawDate).trim();
  if (!s) return null;

  // Tenta ler formatos “dd/mm/yyyy”
  const dm = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dm) {
    let dd = dm[1].padStart(2, '0');
    let mm = dm[2].padStart(2, '0');
    let yyyy = dm[3].length === 2 ? ('20' + dm[3]) : dm[3];
    const parsed = new Date(`${yyyy}-${mm}-${dd}`);
    if (!isNaN(parsed.getTime())) return formatDatePt(parsed);
  }

  const tryD = new Date(s);
  if (!isNaN(tryD.getTime())) return formatDatePt(tryD);
  return null;
}

// Processa o JSON da planilha, transformando cada linha em um objeto de ingrediente
function processSheetJson(jsonRows) {
  if (!jsonRows || jsonRows.length === 0) {
    ingredientes = [];
    return;
  }

  const headers = Object.keys(jsonRows[0] || {});
  const colMap = detectColumnMapping(headers); // Detecta automaticamente o nome das colunas

  ingredientes = jsonRows.map(row => {
    // Busca cada coluna, tentando várias opções de nomes possíveis
    const dataRaw = row[colMap.data] || row["DATA"] || row["Data"] || "";
    const receitaRaw = row[colMap.receita] || row["AULA"] || row["Receita"] || row["UC"] || "";
    const insumoRaw = row[colMap.insumo] || row["ITEM"] || row["Produto"] || row["Insumo"] || "";
    const qtRaw = row[colMap.quantidade] || row["QT"] || row["Quantidade"] || "";
    const undRaw = row[colMap.unidade] || row["UND"] || row["UM"] || "";
    const tipoRaw = row[colMap.tipo] || row["TIPO"] || row["Categoria"] || "";
    const codigoRaw = row["CODIGO MXM"] || row["Código MXM"] || row["CODIGO"] || row["Codigo"] || "";

    // Ignora linhas sem insumo ou receita
    if (!insumoRaw || !receitaRaw) return null;

    // Retorna o objeto processado
    return {
      data: extractDate(dataRaw),
      receita: String(receitaRaw).trim(),
      insumo: String(insumoRaw).trim(),
      qt: parseNumber(qtRaw),
      um: canonicalUnit(undRaw),
      tipo: String(tipoRaw)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase(),
      codigo: String(codigoRaw).trim()
    };
  }).filter(Boolean); // Remove linhas nulas
}

// Agrupa os ingredientes por data e receita (para renderização)
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
// Função que cria os blocos visuais de aulas e receitas no site
function renderCards(filtered) {
  const container = document.getElementById('blocosAulas'); // Pega o container principal
  container.innerHTML = ''; // Limpa o conteúdo anterior

  const grouped = groupByDataReceita(filtered); // Agrupa os itens por data e receita
  const datas = Object.keys(grouped).sort(); // Ordena as datas

  // Percorre cada data
  datas.forEach(data => {
    const aulaCard = document.createElement('div'); // Cria o card da aula
    aulaCard.className = 'aulaCard';

    const header = document.createElement('div'); // Cabeçalho da aula
    header.className = 'aulaHeader';

    const title = document.createElement('div'); // Título com a data e número de receitas
    title.className = 'aulaTitle';
    const receitas = Object.keys(grouped[data]); // Receitas dessa data
    title.textContent = `Data ${data} — ${receitas.length} receitas`;

    header.appendChild(title);
    aulaCard.appendChild(header);

    const receitasList = document.createElement('div'); // Lista de receitas da aula
    receitasList.className = 'receitasList';

    // Percorre todas as receitas da data
    receitas.forEach(receitaName => {
      const insumos = grouped[data][receitaName]; // Lista de ingredientes da receita

      const receitaRow = document.createElement('div'); // Linha principal da receita
      receitaRow.className = 'receitaRow';

      const main = document.createElement('div'); // Área principal com nome e resumo
      main.className = 'receitaMain';

      const nome = document.createElement('div'); // Nome da receita
      nome.className = 'receitaName';
      nome.textContent = receitaName;

      const preview = document.createElement('div'); // Mostra os primeiros ingredientes (prévia)
      preview.className = 'insumosPreview';
      preview.textContent = insumos.map(i => `${i.insumo} (${i.qt}${i.um})`).slice(0,3).join(' • ');

      main.appendChild(nome);
      main.appendChild(preview);

      const controls = document.createElement('div'); // Botão de “ler mais”
      controls.className = 'controls';

      const lerMaisBtn = document.createElement('button'); // Cria botão de expandir
      lerMaisBtn.textContent = 'Ler mais';
      lerMaisBtn.className = 'btn btn-outline';
      lerMaisBtn.style.padding = '6px 10px';

      controls.appendChild(lerMaisBtn);
      receitaRow.appendChild(main);
      receitaRow.appendChild(controls);

      const full = document.createElement('div'); // Área expandida com todos os ingredientes
      full.className = 'insumosFull hidden';

      insumos.forEach(it => {
        const l = document.createElement('div');
        l.textContent = `${it.insumo} — ${it.qt} ${it.um} (${it.tipo})`;
        full.appendChild(l);
      });

      // Alterna entre abrir/fechar a lista de ingredientes
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

// Aplica os filtros de tipo, data e busca
function applyFilters() {
  const tipoSelect = document.getElementById('tipo');
  const tipo = tipoSelect ? tipoSelect.value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : 'todos';
  const buscar = document.getElementById('searchInput').value.trim().toLowerCase();
  const di = document.getElementById('dataInicio').value;
  const df = document.getElementById('dataFim').value;

  // Converte datas do filtro em objetos Date válidos
  const start = di ? new Date(di) : new Date(-8640000000000000);
  const end = df ? new Date(df) : new Date(8640000000000000);

  // Aplica todos os filtros sobre a lista de ingredientes
  return ingredientes.filter(i => {
    const tipoNormalizado = (i.tipo || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const condTipo = (tipo === 'todos') || tipoNormalizado === tipo;
    const condBusca = !buscar || i.insumo.toLowerCase().includes(buscar) || i.receita.toLowerCase().includes(buscar);
    const condData = i.data ? (new Date(i.data) >= start && new Date(i.data) <= end) : true;
    return condTipo && condBusca && condData;
  });
}

// Consolida ingredientes iguais somando quantidades e mantendo códigos
function consolidateForResumo(items) {
  const map = {};

  items.forEach(it => {
    const esp = (it.insumo || '').trim(); // Especificação do produto
    const unitCanon = canonicalUnit(it.um); // Unidade padronizada
    const parsed = parseNumber(it.qt); // Quantidade convertida
    const normalized = normalizeUnitForSum(parsed, unitCanon); // Normaliza unidade para somar

    const key = `${esp.toLowerCase()}@@${normalized.unidade}`; // Chave única por item e unidade

    // Se ainda não existe no mapa, cria; senão soma a quantidade
    if (!map[key]) map[key] = { especificacao: esp, quantidade: 0, unidade: normalized.unidade, codigo: it.codigo };
    map[key].quantidade += normalized.quantidade;
  });

  // Converte unidades grandes novamente para L ou KG se passar de 1000
  const lista = Object.values(map).map(item => {
    if (item.unidade === 'ML' && item.quantidade >= 1000) {
      return { ...item, quantidade: parseFloat((item.quantidade/1000).toFixed(3)), unidade: 'L' };
    }
    if (item.unidade === 'G' && item.quantidade >= 1000) {
      return { ...item, quantidade: parseFloat((item.quantidade/1000).toFixed(2)), unidade: 'KG' };
    }
    return item;
  });

  lista.sort((a,b) => a.especificacao.localeCompare(b.especificacao, 'pt-BR')); // Ordena alfabeticamente
  return lista;
}

// Mostra o resumo consolidado em forma de tabela
function renderResumo(filtrados) {
  const consolidado = consolidateForResumo(filtrados);
  ultimoResumo = consolidado; // Guarda o último resumo gerado

  document.querySelectorAll('.resumo').forEach(e => e.remove()); // Remove resumos anteriores

  const resumoDiv = document.createElement('div');
  resumoDiv.className = 'resumo';

  const title = document.createElement('h2');
  title.textContent = 'Resumo Consolidado';
  title.style.marginTop = '0';
  resumoDiv.appendChild(title);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Quantidade</th><th>Unidade</th><th>Código MXM</th><th>Especificação</th></tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  // Cria linhas da tabela
  consolidado.forEach(item => {
    const tr = document.createElement('tr');
    const codigo = item.codigo || "";
    tr.innerHTML = `<td>${parseFloat(item.quantidade).toFixed(3)}</td><td>${item.unidade}</td><td>${codigo}</td><td>${item.especificacao}</td>`;

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  resumoDiv.appendChild(table);

  document.getElementById('blocosAulas').appendChild(resumoDiv);
  document.getElementById('exportCsvBtn').style.display = 'inline-block'; // Mostra botão de exportar
}

// Exporta o resumo consolidado para um arquivo CSV formatado corretamente
function exportResumoToCSV() {
  if (!ultimoResumo || ultimoResumo.length === 0) {
    alert('Nenhum resumo para exportar. Gere o resumo primeiro.');
    return;
  }

  const rows = [['Quantidade', 'Unidade', 'Código MXM', 'Especificação']]; // Cabeçalho

  // Adiciona as linhas do resumo
  ultimoResumo.forEach(r => {
    rows.push([r.quantidade, r.unidade, r.codigo || '', r.especificacao]);
  });

  // Cria o CSV no formato brasileiro com ponto e vírgula e BOM UTF-8
  const csv = '\uFEFF' + rows.map(r => r.join(';')).join('\n');

  // Cria e baixa o arquivo automaticamente
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'resumo_consolidado.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Quando a página termina de carregar, define todos os eventos
document.addEventListener('DOMContentLoaded', () => {

  // Botão de aplicar filtros
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

  // Botão de gerar o resumo consolidado
  const gerarResumoBtn = document.getElementById('gerarResumoBtn');
  if (gerarResumoBtn) {
    gerarResumoBtn.addEventListener('click', () => {
      const filtrados = applyFilters();
      renderResumo(filtrados);
      const el = document.querySelector('.resumo');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // Botão de exportar o resumo
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', exportResumoToCSV);
    exportCsvBtn.style.display = 'none'; // Oculto até gerar o resumo
  }

  // Input de upload do arquivo Excel
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

  // Carrega lista de cursos salvos no localStorage
  carregarListaCursos();

  // Botão de salvar curso atual
  const btnSalvar = document.getElementById("btnSalvarCurso");
  if (btnSalvar) btnSalvar.addEventListener("click", () => {
    const nome = prompt("Digite um nome para este curso:");
    salvarCurso(nome);
  });

  // Botão de excluir curso salvo
  const btnExcluir = document.getElementById("btnExcluirCurso");
  if (btnExcluir) btnExcluir.addEventListener("click", () => {
    const select = document.getElementById("cursosSalvos");
    if (select && select.value) excluirCurso(select.value);
  });

  // Quando o usuário seleciona um curso salvo
  const sel = document.getElementById("cursosSalvos");
  if (sel) sel.addEventListener("change", (e) => {
    if (e.target.value) carregarCurso(e.target.value);
  });
});

// Salva o curso atual (ingredientes carregados) no localStorage
function salvarCurso(nome) {
  if (!nome) {
    alert("Digite um nome para salvar o curso.");
    return;
  }
  localStorage.setItem("curso_" + nome, JSON.stringify(ingredientes));
  carregarListaCursos();
  alert("Curso salvo com sucesso!");
}

// Carrega um curso salvo do localStorage
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

// Exclui um curso salvo
function excluirCurso(nome) {
  localStorage.removeItem("curso_" + nome);
  carregarListaCursos();
  alert("Curso excluído com sucesso!");
}

// Atualiza a lista de cursos salvos no menu suspenso
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





