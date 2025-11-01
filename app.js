import config from './config.js';

const room = new WebsimSocket();
let lastMessageTime = 0;
let currentChatroom = 'main';
let currentUser = null;
let userRecord = null;
let isCreatingRecord = false;

async function initialize() {
  await room.initialize();
  
  // Get current user info
  currentUser = await window.websim.getCurrentUser();
  
  // Get or create user record
  await getOrCreateUserRecord();

  // Subscribe to all user records for real-time updates
  room.collection('user_messages').subscribe((records) => {
    renderMessagesFromRecords(records);
  });

  // Subscribe to chatroom records
  room.collection('chatrooms').subscribe((chatroomRecords) => {
    renderChatrooms(chatroomRecords);
  });

  document.getElementById('messageForm').addEventListener('submit', handleSubmit);
  document.getElementById('searchInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      searchMessages();
      e.preventDefault();
    }
  });
  
  document.getElementById('chatroomForm').addEventListener('submit', createChatroom);
  
  window.searchMessages = searchMessages;
  window.joinChatroom = joinChatroom;

  // Periodically check for and merge duplicates, as a safeguard
  setInterval(() => {
    if (userRecord) { // Only run if user is initialized
        checkForAndMergeDuplicates();
    }
  }, 30000); // Check every 30 seconds
}

async function getOrCreateUserRecord() {
  if (isCreatingRecord) {
    console.log('Record creation already in progress. Waiting...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    return getOrCreateUserRecord();
  }

  isCreatingRecord = true;

  try {
    let existingRecords = room.collection('user_messages').filter({ user_id: currentUser.id }).getList();
    let attempts = 0;
    while(existingRecords.length === 0 && attempts < 5) {
        await new Promise(resolve => setTimeout(resolve, 500));
        existingRecords = room.collection('user_messages').filter({ user_id: currentUser.id }).getList();
        attempts++;
    }

    if (existingRecords.length > 0) {
      if (existingRecords.length > 1) {
        userRecord = await mergeUserRecords(existingRecords);
      } else {
        userRecord = existingRecords[0];
      }
      
      if (!Array.isArray(userRecord.messages)) {
        await room.collection('user_messages').update(userRecord.id, { messages: [] });
        userRecord.messages = [];
      }
    } else {
      // Create new record for user if none exists
      userRecord = await room.collection('user_messages').create({
        user_id: currentUser.id,
        user_username: currentUser.username,
        messages: []
      });
    }
  } catch (error) {
      console.error("Error getting or creating user record:", error);
  } finally {
      isCreatingRecord = false;
  }
}

async function mergeUserRecords(records) {
    console.log(`Merging ${records.length} records for user ${currentUser.username}`);
    // Keep the oldest record (last in the list from getList)
    const primary = records[records.length - 1];
    const duplicates = records.slice(0, records.length - 1);

    const mergedMessages = [
      ...(Array.isArray(primary.messages) ? primary.messages : []),
      ...duplicates.flatMap(r => (Array.isArray(r.messages) ? r.messages : []))
    ];
    
    // Deduplicate messages just in case
    const uniqueMessages = Array.from(new Map(mergedMessages.map(item => [item.text, item])).values());
    uniqueMessages.sort((a,b) => a.timestamp - b.timestamp);


    await room.collection('user_messages').update(primary.id, {
      messages: uniqueMessages
    });

    for (const dup of duplicates) {
        if (dup.id !== primary.id) {
            try {
                await room.collection('user_messages').delete(dup.id);
            } catch (e) {
                console.warn(`Could not delete duplicate record ${dup.id}:`, e);
            }
        }
    }

    return { ...primary, messages: uniqueMessages };
}

async function checkForAndMergeDuplicates() {
    let existingRecords = room.collection('user_messages').filter({ user_id: currentUser.id }).getList();
    if (existingRecords.length > 1) {
        console.log("Periodic check found duplicates. Merging...");
        userRecord = await mergeUserRecords(existingRecords);
    }
}

function renderMessagesFromRecords(userRecords) {
  const messagesDiv = document.getElementById('messages');
  messagesDiv.innerHTML = '';
  
  // Collect all messages from all users and filter by current chatroom
  const allMessages = [];
  
  userRecords.forEach(record => {
    if (record.messages && Array.isArray(record.messages)) {
      record.messages.forEach(msg => {
        if (msg.chatroom === currentChatroom) {
          allMessages.push({
            ...msg,
            username: record.user_username
          });
        }
      });
    }
  });
  
  // Sort by timestamp
  allMessages.sort((a, b) => a.timestamp - b.timestamp);
    
  if (allMessages.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.textContent = 'No messages yet in this room. Be the first to send something unique!';
    emptyMsg.style.textAlign = 'center';
    emptyMsg.style.color = '#7f8c8d';
    emptyMsg.style.marginTop = '30px';
    messagesDiv.appendChild(emptyMsg);
    return;
  }
  
  allMessages.forEach(msg => {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message';
    
    const usernameSpan = document.createElement('span');
    usernameSpan.className = 'username';
    usernameSpan.textContent = msg.username;
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = new Date(msg.timestamp).toLocaleString();
    
    const contentDiv = document.createElement('div');
    contentDiv.textContent = msg.text;
    
    msgDiv.appendChild(usernameSpan);
    msgDiv.appendChild(timeSpan);
    msgDiv.appendChild(document.createElement('br'));
    msgDiv.appendChild(contentDiv);
    
    messagesDiv.appendChild(msgDiv);
  });
    
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function renderChatrooms(chatroomRecords) {
  const chatroomsDiv = document.getElementById('chatrooms');
  chatroomsDiv.innerHTML = '';
  
  // Add main chatroom
  const mainRoomDiv = document.createElement('div');
  mainRoomDiv.className = 'chatroom' + (currentChatroom === 'main' ? ' active' : '');
  mainRoomDiv.innerHTML = '<span>Main Room</span>';
  mainRoomDiv.onclick = () => joinChatroom('main');
  chatroomsDiv.appendChild(mainRoomDiv);
  
  // Add custom chatrooms
  chatroomRecords.forEach(chatroomRecord => {
    const chatroomDiv = document.createElement('div');
    chatroomDiv.className = 'chatroom' + (currentChatroom === chatroomRecord.id ? ' active' : '');
    
    // Calculate time left
    const timeLeft = chatroomRecord.expiry_time - Date.now();
    let timeLeftText = '';
    
    if (timeLeft <= 0) {
      return; // Skip expired chatrooms
    } else {
      const hours = Math.floor(timeLeft / 3600000);
      const minutes = Math.floor((timeLeft % 3600000) / 60000);
      timeLeftText = `${hours}h ${minutes}m left`;
    }
    
    chatroomDiv.innerHTML = `
      <span>${chatroomRecord.room_name}</span>
      <span class="expiry-time">${timeLeftText}</span>
    `;
    chatroomDiv.onclick = () => joinChatroom(chatroomRecord.id);
    chatroomsDiv.appendChild(chatroomDiv);
  });
  
  // Update expiry times every minute
  setTimeout(updateExpiryTimes, 60000);
}

function updateExpiryTimes() {
  const chatroomRecords = room.collection('chatrooms').getList();
  
  // Check for expired chatrooms and delete them
  const now = Date.now();
  let hasExpired = false;
  
  chatroomRecords.forEach(chatroomRecord => {
    if (chatroomRecord.expiry_time <= now) {
      // Delete expired chatroom
      room.collection('chatrooms').delete(chatroomRecord.id);
      hasExpired = true;
      
      // If current chatroom expired, go back to main
      if (currentChatroom === chatroomRecord.id) {
        currentChatroom = 'main';
        updateCurrentRoom();
      }
    }
  });
  
  if (!hasExpired) {
    // Just re-render with updated times
    renderChatrooms(chatroomRecords);
  }
}

function joinChatroom(chatroomId) {
  currentChatroom = chatroomId;
  updateCurrentRoom();
  const userRecords = room.collection('user_messages').getList();
  renderMessagesFromRecords(userRecords);
}

function updateCurrentRoom() {
  const roomNameElement = document.getElementById('currentRoom');
  
  if (currentChatroom === 'main') {
    roomNameElement.textContent = 'Main Room';
    return;
  }
  
  const chatroomRecords = room.collection('chatrooms').getList();
  const currentRoomData = chatroomRecords.find(room => room.id === currentChatroom);
  
  if (currentRoomData) {
    roomNameElement.textContent = currentRoomData.room_name;
  } else {
    // If room doesn't exist anymore, go back to main
    currentChatroom = 'main';
    roomNameElement.textContent = 'Main Room';
  }
}

async function createChatroom(e) {
  e.preventDefault();
  const chatroomInput = document.getElementById('chatroomInput');
  const chatroomError = document.getElementById('chatroomError');
  const chatroomName = chatroomInput.value.trim();
  
  if (!chatroomName) return;
  
  chatroomError.className = 'error';
  
  // Check for invalid characters
  if (!/^[a-zA-Z0-9\s!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+$/.test(chatroomName)) { 
    chatroomError.textContent = 'Room name contains characters that cannot be typed on a standard keyboard.';
    chatroomError.className = 'error active';
    return;
  }
  
  // Check for zero-width spaces
  if (chatroomName.includes('​')) { 
    chatroomError.textContent = 'Room name contains invisible characters that are not allowed.';
    chatroomError.className = 'error active';
    return;
  }
  
  // Check if chatroom name exists
  const chatroomRecords = room.collection('chatrooms').getList();
  const isDuplicate = chatroomRecords.some(room => 
    room.room_name.toLowerCase() === chatroomName.toLowerCase()
  );
  
  if (isDuplicate) {
    chatroomError.textContent = 'That room name has already been used! Try something unique.';
    chatroomError.className = 'error active';
    return;
  }
  
  // Create chatroom
  const expiryTime = Date.now() + config.ROOM_EXPIRY_TIME;
  
  const newChatroom = await room.collection('chatrooms').create({
    room_name: chatroomName,
    creator: currentUser.username,
    expiry_time: expiryTime
  });
  
  chatroomInput.value = '';
  joinChatroom(newChatroom.id);
}

async function handleSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('messageInput');
  const errorDiv = document.getElementById('error');
  const message = input.value.trim();

  if (!message) return;
  
  errorDiv.className = 'error';

  // Check for invalid characters
  if (!/^[a-zA-Z0-9\s!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+$/.test(message)) { 
    errorDiv.textContent = 'Message contains characters that cannot be typed on a standard keyboard.';
    errorDiv.className = 'error active';
    return;
  }
  
  // Check for zero-width spaces
  if (message.includes('​')) { 
    errorDiv.textContent = 'Message contains invisible characters that are not allowed.';
    errorDiv.className = 'error active';
    return;
  }
  
  // Check message length
  if (message.length > config.MAX_CHARS) {
    errorDiv.textContent = `Message is too long. Maximum is ${config.MAX_CHARS} characters.`;
    errorDiv.className = 'error active';
    return;
  }

  // Check cooldown
  const now = Date.now();
  if (now - lastMessageTime < config.COOLDOWN_TIME) {
    errorDiv.textContent = `Please wait ${Math.ceil((config.COOLDOWN_TIME - (now - lastMessageTime)) / 1000)}s before sending another message`;
    errorDiv.className = 'error cooldown active';
    return;
  }

  // Check if message exists in ANY user's message list (universal uniqueness)
  const allUserRecords = room.collection('user_messages').getList();
  const isDuplicate = allUserRecords.some(userRecord => {
    if (!userRecord.messages || !Array.isArray(userRecord.messages)) return false;
    return userRecord.messages.some(msg => 
      msg.text.toLowerCase() === message.toLowerCase()
    );
  });
  
  if (isDuplicate) {
    errorDiv.textContent = 'That message has already been sent! Try something unique.';
    errorDiv.className = 'error active';
    return;
  }

  // Add message to user's record
  const newMessage = {
    text: message,
    timestamp: Date.now(),
    chatroom: currentChatroom
  };
  
  const updatedMessages = [...(userRecord.messages || []), newMessage];
  
  await room.collection('user_messages').update(userRecord.id, {
    messages: updatedMessages
  });
  
  // Update local reference
  userRecord.messages = updatedMessages;

  lastMessageTime = now;
  input.value = '';
  errorDiv.textContent = '';
  errorDiv.className = 'error';
}

function searchMessages() {
  const searchTerm = document.getElementById('searchInput').value.trim().toLowerCase();
  const searchResults = document.getElementById('searchResults');
  searchResults.innerHTML = '';

  if (!searchTerm) return;

  const allUserRecords = room.collection('user_messages').getList();
  const chatroomRecords = room.collection('chatrooms').getList();
  const matches = [];

  // Search through all user messages
  allUserRecords.forEach(userRecord => {
    if (!userRecord.messages || !Array.isArray(userRecord.messages)) return;
    
    userRecord.messages.forEach(msg => {
      if (msg.text.toLowerCase().includes(searchTerm)) {
        matches.push({
          ...msg,
          username: userRecord.user_username
        });
      }
    });
  });

  // Sort by timestamp
  matches.sort((a, b) => a.timestamp - b.timestamp);

  if (matches.length === 0) {
    searchResults.innerHTML = '<div class="search-result">No matches found</div>';
    return;
  }

  matches.forEach(msg => {
    const result = document.createElement('div');
    result.className = 'search-result';
    const time = new Date(msg.timestamp).toLocaleString();
    
    // Get chatroom name
    let chatroomName = 'Main Room';
    if (msg.chatroom && msg.chatroom !== 'main') {
      const chatroomRecord = chatroomRecords.find(room => room.id === msg.chatroom);
      if (chatroomRecord) {
        chatroomName = chatroomRecord.room_name;
      } else {
        chatroomName = 'Expired Room';
      }
    }
    
    result.innerHTML = `
      <strong>${msg.username}</strong> said "<em>${msg.text}</em>" 
      on ${time} in <span class="room-tag">${chatroomName}</span>
      <button class="goto-room" onclick="joinChatroom('${msg.chatroom}')">Go to Room</button>
    `;
    searchResults.appendChild(result);
  });
}

initialize();