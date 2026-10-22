const roles = { intent: '意圖協調', planner: '旅遊規劃', flight: '航班查詢', price: '票價與購買' };

export function createAgentStatus(element) {
  let current = null;
  function render(role, status) {
    element.textContent = role ? `${roles[role]} · ${status === 'completed' ? '已完成' : '處理中'}` : '等待對話';
    element.title = role ? `${roles[role]}代理（${role}）` : '依後端實際進度顯示代理，不推測尚未收到的狀態';
    element.dataset.status = status;
    element.dataset.role = role ?? '';
  }
  function clear() { current = null; render(null, 'idle'); }
  clear();
  return {
    clear,
    start(id) { current = id; render(null, 'idle'); },
    update(id, role, status = 'processing') {
      if (current !== id || !current || !Object.hasOwn(roles, role) || !['processing', 'completed'].includes(status)) return;
      if (element.dataset.status === 'completed' && status === 'processing') return;
      render(role, status);
    },
    unavailable(id) {
      if (id === current && element.dataset.status !== 'completed') {
        render(null, 'unavailable'); element.textContent = '代理狀態暫時無法取得';
      }
    }
  };
}
