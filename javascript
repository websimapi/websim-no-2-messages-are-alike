// ...existing code...
async function handleSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('messageInput');
  const errorDiv = document.getElementById('error');
  const message = input.value.trim();

  if (!message) return;
  
  // Safeguard against sending messages before initialization is complete
  if (!userRecord || !userRecord.id) {
      errorDiv.textContent = 'Still initializing, please wait a moment...';
      errorDiv.className = 'error active';
      return;
  }
  
  errorDiv.className = 'error';

  // Check for invalid characters
// ...existing code...

