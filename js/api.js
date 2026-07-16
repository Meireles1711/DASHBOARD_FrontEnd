/* ============================================================================
   PAINEL DE MONITORAMENTO — SECCIONADORA INDUSTRIAL
   api.js — toda a lógica de dados, regras de estado e renderização
   ============================================================================

   COMO FUNCIONA (visão geral):

     Backend (Node.js)  --->  fetchMachineData()  --->  determineState()  --->  render()
        envia os dados        busca/recebe o          decide qual das 6         atualiza
        brutos da máquina     payload mais recente     telas exibir             o DOM

   Nada de estado fica "chumbado" em botão. Tudo passa por um único payload
   de dados (MachineDataPayload, descrito abaixo) que o backend envia, e a
   função determineState() é a ÚNICA responsável por decidir qual tela
   (normal / alerta / critico / desligada / ligada / manutencao) mostrar.

   ----------------------------------------------------------------------------
   CONTRATO DE DADOS ESPERADO DO BACKEND (MachineDataPayload):
   ----------------------------------------------------------------------------
   {
     ligada:            boolean,        // motor energizado?
     iniciando:         boolean,        // true logo após ligar (fase de warm-up)
     manutencao:        boolean,        // true quando a máquina foi colocada em manutenção
     temperaturaMotor:  number|null,    // °C. null quando não há leitura (máquina desligada)
     pressaoPneumatica: number|null,    // bar (0-10). null quando não há leitura
     horasOperacao:     string|number,  // "8h 17m" já formatado, OU minutos totais (number)
     cortesRealizados:  number,
     eficiencia:        number          // 0-100
   }

   Ajuste CONFIG.API_URL e o parsing dentro de fetchMachineData() para bater
   com o formato real que seu endpoint Node.js retorna.
   ============================================================================ */


/* ============================================================================
   1. CONFIGURAÇÃO GERAL
   ============================================================================ */
const CONFIG = {
  // Endpoint do backend Node.js que devolve o MachineDataPayload em JSON.
  API_URL: '/api/maquina/status',

  // Endpoint de WebSocket (opcional). Deixe null para usar apenas polling REST.
  WS_URL: null, // ex.: 'wss://seu-servidor.com/maquina/status'

  // Intervalo do polling REST, em milissegundos (ignorado se WS_URL estiver definido).
  POLL_INTERVAL_MS: 5000,

  // true  = usa dados simulados (painel de botões no rodapé), sem chamar o backend.
  // false = busca dados reais em API_URL (ou WS_URL).
  USE_MOCK: true,
};


/* ============================================================================
   2. PALETA DE CORES E ÍCONES (puramente visual)
   ============================================================================ */
const COLORS = {
  verde:    '#22C55E',
  amarelo:  '#DDC126',
  vermelho: '#EF4444',
  cinza:    '#54545A',
  azul:     '#004AAD',
};

const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3.4"/><path d="M12 3.5v2.6M12 17.9v2.6M20.5 12h-2.6M6.1 12H3.5M17.8 6.2l-1.85 1.85M8.05 15.95l-1.85 1.85M17.8 17.8l-1.85-1.85M8.05 8.05 6.2 6.2"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 22 20H2z"/><path d="M12 10v4.2"/><circle cx="12" cy="17.3" r=".15" fill="currentColor" stroke-width="2.4"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.6" r=".2" stroke-width="2.6"/></svg>',
};


/* ============================================================================
   3. CONTEÚDO VISUAL FIXO DE CADA ESTADO
   ----------------------------------------------------------------------------
   Aqui só entra o que é "texto de rótulo" (não vem do backend): título do
   card de status, ícone, mensagem do card de alerta e lista de ações
   recomendadas. Os NÚMEROS (temperatura, pressão, horas, cortes,
   eficiência) vêm sempre do payload do backend — ver aplicarDados().
   ============================================================================ */
const STATE_VISUALS = {
  normal: {
    badge: '01 — Operação normal',
    accent: COLORS.verde,
    status: { icon: ICONS.check, iconBg: COLORS.verde, iconBorder: 'transparent', title: 'Em Operação', titleColor: COLORS.verde, subtitle: 'Operando' },
    alerta: { icon: ICONS.shield, iconBg: COLORS.verde, iconBorder: 'transparent', title: 'Tudo esta ok!', desc: '' },
    acoes: [],
  },
  alerta: {
    badge: '02 — Alerta',
    accent: COLORS.amarelo,
    status: { icon: ICONS.gear, iconBg: 'transparent', iconBorder: COLORS.amarelo, title: 'Em Operação', titleColor: COLORS.amarelo, subtitle: 'Operando' },
    alerta: { icon: ICONS.warning, iconBg: 'transparent', iconBorder: COLORS.amarelo, title: 'Verifique a Temperatura', desc: 'A temperatura está acima do ideal' },
    acoes: ['Reduzir a carga de trabalho', 'Monitorar continuamente a temperatura'],
  },
  critico: {
    badge: '03 — Alerta crítico',
    accent: COLORS.vermelho,
    status: { icon: ICONS.gear, iconBg: 'transparent', iconBorder: COLORS.vermelho, title: 'Em Alerta', titleColor: COLORS.vermelho, subtitle: 'Crítico' },
    alerta: { icon: ICONS.warning, iconBg: 'transparent', iconBorder: COLORS.vermelho, title: 'Verifique a Temperatura', desc: 'A temperatura está acima do ideal!' },
    acoes: ['Interromper o uso da máquina', 'Desligue a alimentação elétrica'],
  },
  desligada: {
    badge: '04 — Máquina desligada',
    accent: COLORS.cinza,
    status: { icon: ICONS.power, iconBg: 'transparent', iconBorder: COLORS.cinza, title: 'Máquina Desligada', titleColor: COLORS.cinza, subtitle: 'Inátiva' },
    alerta: { icon: ICONS.info, iconBg: 'transparent', iconBorder: COLORS.cinza, title: 'Máquina Desligada', desc: 'Sem operação no momento' },
    acoes: [],
  },
  ligada: {
    badge: '05 — Máquina ligada',
    accent: COLORS.azul,
    status: { icon: ICONS.power, iconBg: COLORS.azul, iconBorder: 'transparent', title: 'Máquina Ligada', titleColor: COLORS.azul, subtitle: 'Iniciando' },
    alerta: { icon: ICONS.shield, iconBg: COLORS.verde, iconBorder: 'transparent', title: 'Tudo esta ok!', desc: 'Iniciação em andamento' },
    acoes: ['Aguarde a máquina atingir o estado operacional'],
  },
  manutencao: {
    badge: '06 — Em manutenção',
    accent: '#4D2C39',
    status: { icon: ICONS.check, iconBg: COLORS.verde, iconBorder: 'transparent', title: 'Em Operação', titleColor: COLORS.verde, subtitle: 'Operando' },
    alerta: { icon: ICONS.shield, iconBg: COLORS.verde, iconBorder: 'transparent', title: 'Tudo esta ok!', desc: '' },
    acoes: [],
    overlay: { titulo: 'Em Manutenção', desc: 'A máquina está em manutenção.<br>Retornaremos em breve!' },
  },
};


/* ============================================================================
   4. REGRAS DE NEGÓCIO — determinação do estado a partir dos dados
   ----------------------------------------------------------------------------
   Esta é a função que substitui os antigos botões "01, 02, 03...". Ela
   recebe o payload cru do backend e devolve QUAL das chaves de
   STATE_VISUALS deve ser exibida. Ajuste os limiares (100°C, 85°C etc.)
   conforme a especificação real do equipamento.
   ============================================================================ */

/** Classifica a temperatura em cor/legenda/percentual da barra. */
function classificarTemperatura(temperaturaMotor) {
  if (temperaturaMotor === null || temperaturaMotor === undefined) {
    return { cor: COLORS.cinza, legenda: 'Sem leitura', percentual: 0 };
  }
  if (temperaturaMotor >= 100) {
    return { cor: COLORS.vermelho, legenda: 'Muito acima do ideal', percentual: Math.min(temperaturaMotor, 100) };
  }
  if (temperaturaMotor >= 85) {
    return { cor: COLORS.amarelo, legenda: 'Acima do ideal', percentual: Math.min(temperaturaMotor, 100) };
  }
  return { cor: COLORS.verde, legenda: 'Temperatura ideal', percentual: Math.min(Math.max(temperaturaMotor, 0), 100) };
}

/** Classifica a pressão pneumática (0-10 bar) em percentual de barra. */
function classificarPressao(pressaoPneumatica) {
  const ativo = pressaoPneumatica !== null && pressaoPneumatica !== undefined;
  const percentual = ativo ? Math.min(Math.max((pressaoPneumatica / 10) * 100, 0), 100) : 0;
  return { ativo, percentual };
}

/**
 * Decide qual tela (chave de STATE_VISUALS) deve ser exibida, com base
 * SOMENTE nos dados recebidos do backend. Ordem de prioridade:
 *   1. manutenção (sempre vence, independente de qualquer outra leitura)
 *   2. máquina desligada
 *   3. máquina ligando/aquecendo (iniciando)
 *   4. temperatura crítica
 *   5. temperatura em alerta
 *   6. operação normal
 */
function determineState(data) {
  if (data.manutencao) return 'manutencao';
  if (!data.ligada) return 'desligada';
  if (data.iniciando) return 'ligada';

  const temp = classificarTemperatura(data.temperaturaMotor);
  if (data.temperaturaMotor >= 100) return 'critico';
  if (data.temperaturaMotor >= 85) return 'alerta';
  return 'normal';
}


/* ============================================================================
   5. COMUNICAÇÃO COM O BACKEND (Node.js)
   ============================================================================ */

/** Formata minutos totais em "8h 17m". Aceita string já formatada também. */
function formatarHoras(horasOperacao) {
  if (typeof horasOperacao === 'string') return horasOperacao;
  if (typeof horasOperacao === 'number') {
    const h = Math.floor(horasOperacao / 60);
    const m = horasOperacao % 60;
    return `${h}h ${m}m`;
  }
  return '—';
}

/**
 * Busca o payload mais recente da máquina.
 * - Em modo mock (CONFIG.USE_MOCK = true): devolve um dos payloads de
 *   MOCK_PAYLOADS (usado pelo painel de simulação no rodapé).
 * - Em modo real (CONFIG.USE_MOCK = false): faz um GET em CONFIG.API_URL.
 *
 * Ajuste o `return` do bloco `else` para bater com o formato de resposta
 * real do seu endpoint Node.js (ex.: se vier como { data: {...} }, troque
 * `return await resp.json();` por `return (await resp.json()).data;`).
 */
async function fetchMachineData() {
  if (CONFIG.USE_MOCK) {
    return currentMockPayload;
  }
  const resp = await fetch(CONFIG.API_URL, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`Falha ao buscar dados da máquina: HTTP ${resp.status}`);
  return await resp.json();
}

/**
 * Alternativa via WebSocket, para quando o Node.js empurra os dados em
 * tempo real (ex.: com a lib `ws` ou Socket.IO no backend) em vez de
 * esperar polling. Descomente connectWebSocket() em init() para usar,
 * e mantenha CONFIG.WS_URL preenchido.
 */
function connectWebSocket() {
  const socket = new WebSocket(CONFIG.WS_URL);
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      aplicarDados(data);
    } catch (err) {
      console.error('Payload de WebSocket inválido:', err);
    }
  };
  socket.onclose = () => {
    console.warn('WebSocket desconectado. Tentando reconectar em 3s...');
    setTimeout(connectWebSocket, 3000);
  };
  return socket;
}

/** Processa um novo payload: decide o estado e manda renderizar. */
function aplicarDados(data) {
  const stateKey = determineState(data);
  render(stateKey, data);
}

/** Inicia o ciclo de polling REST (ignorado se estiver usando WebSocket). */
function startPolling() {
  const tick = async () => {
    try {
      const data = await fetchMachineData();
      aplicarDados(data);
    } catch (err) {
      console.error('Erro ao atualizar o painel:', err);
    }
  };
  tick(); // primeira busca imediata
  setInterval(tick, CONFIG.POLL_INTERVAL_MS);
}


/* ============================================================================
   6. RENDERIZAÇÃO — aplica um estado + payload de dados no DOM
   ============================================================================ */
function render(stateKey, data) {
  const visual = STATE_VISUALS[stateKey];
  if (!visual) { console.error('Estado desconhecido:', stateKey); return; }

  setBadge(visual);
  setStatusCard(visual, data);
  setAlertaCard(visual);
  setAcoesCard(visual);
  setTemperaturaCard(data);
  setPressaoCard(data);
  setOverlay(visual);
  setBotaoAtivo(stateKey);
}

function setBadge(visual) {
  document.body.style.setProperty('--accent', visual.accent);
  document.getElementById('stateBadge').textContent = visual.badge;
}

function setStatusCard(visual, data) {
  const iconCircle = document.getElementById('statusIconCircle');
  iconCircle.style.background = visual.status.iconBg;
  iconCircle.style.border = visual.status.iconBorder !== 'transparent' ? `2.5px solid ${visual.status.iconBorder}` : 'none';
  iconCircle.style.color = visual.status.iconBg !== 'transparent' ? '#fff' : visual.status.iconBorder;
  iconCircle.innerHTML = visual.status.icon;

  const title = document.getElementById('statusTitle');
  title.textContent = visual.status.title;
  title.style.color = visual.status.titleColor;
  document.getElementById('statusSubtitle').textContent = visual.status.subtitle;

  // Métricas numéricas vêm sempre do payload do backend, nunca do STATE_VISUALS.
  document.getElementById('metricHoras').textContent = data.ligada ? formatarHoras(data.horasOperacao) : '—';
  document.getElementById('metricCortes').textContent = data.ligada ? data.cortesRealizados : '—';
  document.getElementById('metricEficiencia').textContent = data.ligada ? `${data.eficiencia}%` : '—';
}

function setAlertaCard(visual) {
  const circle = document.getElementById('alertaIconCircle');
  circle.style.background = visual.alerta.iconBg;
  circle.style.border = visual.alerta.iconBorder !== 'transparent' ? `2.5px solid ${visual.alerta.iconBorder}` : 'none';
  circle.style.color = visual.alerta.iconBg !== 'transparent' ? '#fff' : visual.alerta.iconBorder;
  circle.innerHTML = visual.alerta.icon;

  const title = document.getElementById('alertaTitle');
  title.textContent = visual.alerta.title;
  title.style.color = visual.alerta.iconBorder !== 'transparent' ? visual.alerta.iconBorder : visual.alerta.iconBg;
  document.getElementById('alertaDesc').textContent = visual.alerta.desc;
}

function setAcoesCard(visual) {
  const list = document.getElementById('acoesList');
  list.innerHTML = visual.acoes.length
    ? visual.acoes.map(a => `<div class="acoes-item">${a}</div>`).join('')
    : '<div class="acoes-empty">Nenhuma ação necessária</div>';
}

function setTemperaturaCard(data) {
  const info = classificarTemperatura(data.temperaturaMotor);
  const valueEl = document.getElementById('tempValue');
  valueEl.textContent = data.temperaturaMotor != null ? `${data.temperaturaMotor}°C` : '--°C';
  valueEl.style.color = info.cor;
  document.getElementById('tempThermo').style.color = info.cor;

  const captionEl = document.getElementById('tempCaption');
  captionEl.textContent = info.legenda;
  captionEl.style.color = info.cor;

  const fillEl = document.getElementById('tempFill');
  fillEl.style.width = info.percentual + '%';
  fillEl.style.background = data.temperaturaMotor != null ? info.cor : 'transparent';
}

function setPressaoCard(data) {
  const info = classificarPressao(data.pressaoPneumatica);
  document.getElementById('pressValue').textContent = info.ativo ? `${data.pressaoPneumatica} bar` : '-- bar';
  document.getElementById('pressCaption').textContent = info.ativo ? `~${Math.round(data.pressaoPneumatica * 14.5)} PSI` : '-- PSI';

  const fillEl = document.getElementById('pressFill');
  fillEl.style.width = info.percentual + '%';
  fillEl.style.background = info.ativo ? '#22C55E' : 'transparent';
}

function setOverlay(visual) {
  const overlay = document.getElementById('maintenanceOverlay');
  const grid = document.getElementById('grid');
  if (visual.overlay) {
    overlay.classList.add('active');
    grid.classList.add('dimmed');
    document.getElementById('maintenanceTitle').textContent = visual.overlay.titulo;
    document.getElementById('maintenanceDesc').innerHTML = visual.overlay.desc;
  } else {
    overlay.classList.remove('active');
    grid.classList.remove('dimmed');
  }
}


/* ============================================================================
   7. PAINEL DE SIMULAÇÃO (DEV) — payloads falsos "como se vindos do backend"
   ----------------------------------------------------------------------------
   Isto existe só para você ver o painel funcionando sem precisar do
   Node.js rodando. Cada botão chama aplicarDados(payload), OU SEJA, passa
   pelo MESMO determineState() que seria usado com dados reais — nada é
   "forçado" diretamente na tela. Quando plugar o backend de verdade:
     1. mude CONFIG.USE_MOCK para false
     2. apague este bloco 7 inteiro
     3. apague a <div id="stateSwitcher"> do index.html
   ============================================================================ */
const MOCK_PAYLOADS = {
  normal:     { ligada: true,  iniciando: false, manutencao: false, temperaturaMotor: 80,  pressaoPneumatica: 6, horasOperacao: '8h 17m', cortesRealizados: 640, eficiencia: 95 },
  alerta:     { ligada: true,  iniciando: false, manutencao: false, temperaturaMotor: 90,  pressaoPneumatica: 6, horasOperacao: '8h 17m', cortesRealizados: 640, eficiencia: 95 },
  critico:    { ligada: true,  iniciando: false, manutencao: false, temperaturaMotor: 100, pressaoPneumatica: 6, horasOperacao: '8h 17m', cortesRealizados: 640, eficiencia: 95 },
  desligada:  { ligada: false, iniciando: false, manutencao: false, temperaturaMotor: null, pressaoPneumatica: null, horasOperacao: 0, cortesRealizados: 0, eficiencia: 0 },
  ligada:     { ligada: true,  iniciando: true,  manutencao: false, temperaturaMotor: 10,  pressaoPneumatica: null, horasOperacao: '0h 7m', cortesRealizados: 0, eficiencia: 5 },
  manutencao: { ligada: true,  iniciando: false, manutencao: true,  temperaturaMotor: null, pressaoPneumatica: null, horasOperacao: '8h 17m', cortesRealizados: 640, eficiencia: 95 },
};

let currentMockPayload = MOCK_PAYLOADS.normal;

const BOTOES_SIMULACAO = [
  { key: 'normal',     label: '01 Normal' },
  { key: 'alerta',     label: '02 Alerta' },
  { key: 'critico',    label: '03 Crítico' },
  { key: 'desligada',  label: '04 Desligada' },
  { key: 'ligada',     label: '05 Ligada' },
  { key: 'manutencao', label: '06 Manutenção' },
];

function montarPainelSimulacao() {
  const container = document.getElementById('stateSwitcher');
  if (!container) return;
  BOTOES_SIMULACAO.forEach(({ key, label }) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.dataset.key = key;
    btn.onclick = () => {
      currentMockPayload = MOCK_PAYLOADS[key];
      aplicarDados(currentMockPayload); // passa pelo determineState(), igual dado real
    };
    container.appendChild(btn);
  });
}

function setBotaoAtivo(stateKey) {
  document.querySelectorAll('.state-switcher button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.key === stateKey);
  });
}


/* ============================================================================
   8. INICIALIZAÇÃO
   ============================================================================ */
function init() {
  if (document.getElementById('stateSwitcher')) montarPainelSimulacao();

  if (CONFIG.WS_URL) {
    connectWebSocket();
  } else {
    startPolling();
  }
}

document.addEventListener('DOMContentLoaded', init);
