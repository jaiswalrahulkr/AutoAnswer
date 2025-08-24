// Options page script for AutoAnswer AI

document.addEventListener('DOMContentLoaded', async () => {
  const providerSelect = document.getElementById('apiProvider');
  const openaiApiKeyInput = document.getElementById('openaiApiKey');
  const openaiModelInput = document.getElementById('openaiModel');
  const geminiApiKeyInput = document.getElementById('geminiApiKey');
  const geminiModelInput = document.getElementById('geminiModel');
  const autoSubmitCheckbox = document.getElementById('autoSubmit');
  const saveBtn = document.getElementById('saveBtn');
  const status = document.getElementById('status');

  const paymentScannerUrlInput = document.getElementById('paymentScannerUrl');
  const paymentSupportEmailInput = document.getElementById('paymentSupportEmail');

  const { openaiApiKey, openaiModel, autoSubmit, apiProvider, geminiApiKey, geminiModel, paymentScannerUrl, paymentSupportEmail } = await chrome.storage.sync.get(['openaiApiKey', 'openaiModel', 'autoSubmit', 'apiProvider', 'geminiApiKey', 'geminiModel', 'paymentScannerUrl', 'paymentSupportEmail']);
  openaiApiKeyInput.value = openaiApiKey || '';
  openaiModelInput.value = openaiModel || 'gpt-4o-mini';
  providerSelect.value = apiProvider || 'openai';
  geminiApiKeyInput.value = geminiApiKey || '';
  geminiModelInput.value = geminiModel || 'gemini-1.5-flash';
  autoSubmitCheckbox.checked = !!autoSubmit;
  paymentScannerUrlInput.value = paymentScannerUrl || '';
  paymentSupportEmailInput.value = paymentSupportEmail || '';

  saveBtn.addEventListener('click', async () => {
    await chrome.storage.sync.set({
      openaiApiKey: openaiApiKeyInput.value.trim(),
      openaiModel: openaiModelInput.value.trim(),
      autoSubmit: autoSubmitCheckbox.checked,
      apiProvider: providerSelect.value,
      geminiApiKey: geminiApiKeyInput.value.trim(),
      geminiModel: geminiModelInput.value.trim(),
      paymentScannerUrl: paymentScannerUrlInput.value.trim(),
      paymentSupportEmail: paymentSupportEmailInput.value.trim()
    });
    status.textContent = 'Saved';
    setTimeout(() => status.textContent = '', 1500);
  });
});


