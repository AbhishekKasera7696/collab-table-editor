const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const redis = require('redis');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin:"http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Store io instance for use in routes
app.set('socketio', io);

// PostgreSQL connection
const pgPool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
});

// Redis connection
const redisClient = redis.createClient();
redisClient.connect().catch(console.error);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Initialize database tables and Redis data structures
async function initDatabase() {
  try {
    // Create documents table
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        content JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create users table
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Initialize Redis sets and hashes if they don't exist
    await redisClient.del('online_users'); // Clear previous sessions
    await redisClient.del('user_cursors');
    await redisClient.del('user_sockets');

    // Insert default document if not exists
    const result = await pgPool.query('SELECT COUNT(*) FROM documents');
    if (parseInt(result.rows[0].count) === 0) {
      const initialDocument = {
        tables: [],
        users: []
      };
      await pgPool.query(
        'INSERT INTO documents (content) VALUES ($1)',
        [initialDocument]
      );
    }

    console.log('Database and Redis initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

initDatabase();

// Authentication endpoint
app.post('/api/login', async (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    // Store user in Redis
    await redisClient.sAdd('online_users', username);
    
    // Store user in PostgreSQL if not exists
    await pgPool.query(
      'INSERT INTO users (username) VALUES ($1) ON CONFLICT (username) DO NOTHING',
      [username]
    );
    
    res.json({ success: true, username });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get document endpoint
app.get('/api/document', async (req, res) => {
  try {
    const result = await pgPool.query('SELECT content FROM documents ORDER BY id DESC LIMIT 1');
    res.json(result.rows[0].content);
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update document endpoint
app.post('/api/document', async (req, res) => {
  const { content } = req.body;
  
  try {
    await pgPool.query(
      'UPDATE documents SET content = $1, updated_at = NOW() WHERE id = (SELECT id FROM documents ORDER BY id DESC LIMIT 1)',
      [content]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/logout', async (req, res) => {
  const { username } = req.body;
  
  console.log('Logout request received for username:', username);
  
  if (!username) {
    console.log('Logout failed: Username is required');
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    // Remove user from Redis sets
    await redisClient.sRem('online_users', username);
    await redisClient.hDel('user_cursors', username);
    
    // Get socket ID from Redis
    const socketId = await redisClient.hGet('user_sockets', username);
    
    console.log('Socket ID for user:', socketId);
    
    if (socketId) {
      // Remove socket ID from Redis
      await redisClient.hDel('user_sockets', username);
      
      // Get socket.io instance and disconnect user's socket
      const io = req.app.get('socketio');
      const socket = io.sockets.sockets.get(socketId);
      
      if (socket) {
        console.log('Disconnecting socket for user:', username);
        socket.disconnect(true);
      }
    }
    
    // Broadcast user left to all clients
    const io = req.app.get('socketio');
    io.emit('user_left', username);
    
    // Send updated online users
    const onlineUsers = await redisClient.sMembers('online_users');
    io.emit('online_users', onlineUsers);
    
    console.log('Logout successful for user:', username);
    res.json({ success: true, message: 'User logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Socket connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('join', async (username) => {
    try {
      socket.username = username;
      
      // Store user info in Redis with socket ID
      await redisClient.hSet('user_sockets', username, socket.id);
      
      // Add user to online users set
      await redisClient.sAdd('online_users', username);
      
      // Broadcast user joined
      socket.broadcast.emit('user_joined', username);
      
      // Send current online users to all clients
      const onlineUsers = await redisClient.sMembers('online_users');
      io.emit('online_users', onlineUsers);
      
      console.log(`User ${username} joined with socket ID: ${socket.id}`);
    } catch (error) {
      console.error('Error in join event:', error);
    }
  });
  
  socket.on('cursor_move', async (data) => {
    try {
      // Store cursor position in Redis
      if (socket.username) {
        await redisClient.hSet(
          'user_cursors', 
          socket.username, 
          JSON.stringify({
            x: data.x,
            y: data.y,
            username: socket.username
          })
        );
        
        // Broadcast cursor position to other users
        socket.broadcast.emit('user_cursor', {
          username: socket.username,
          x: data.x,
          y: data.y
        });
      }
    } catch (error) {
      console.error('Error in cursor_move event:', error);
    }
  });
  
  socket.on('table_update', async (data) => {
    try {
      // Broadcast table update to other users
      socket.broadcast.emit('table_updated', data);
      
      // Update document in database
      await pgPool.query(
        'UPDATE documents SET content = $1, updated_at = NOW() WHERE id = (SELECT id FROM documents ORDER BY id DESC LIMIT 1)',
        [data.document]
      );
    } catch (error) {
      console.error('Error updating document:', error);
    }
  });
  
  socket.on('disconnect', async () => {
    try {
      // Remove user from Redis
      if (socket.username) {
        await redisClient.sRem('online_users', socket.username);
        await redisClient.hDel('user_cursors', socket.username);
        await redisClient.hDel('user_sockets', socket.username);
        
        // Broadcast user left
        socket.broadcast.emit('user_left', socket.username);
        
        // Send updated online users
        const onlineUsers = await redisClient.sMembers('online_users');
        io.emit('online_users', onlineUsers);
      }
      
      console.log('User disconnected:', socket.id);
    } catch (error) {
      console.error('Error in disconnect event:', error);
    }
  });
});

server.listen(process.env.PORT, () => {
  console.log(`Server running on port ${PORT}`);
});