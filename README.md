# Maximum Crypto Trading Platform

## Overview

Maximum is a Node.js-based cryptocurrency trading platform that provides real-time Bitcoin price tracking, user authentication, and administrative features. The application uses Express.js for the web server, MySQL for data persistence, Socket.IO for real-time updates, and EJS for templating.

## Features

- **User Authentication**: Registration, login, and logout functionality with session management
- **Real-time Price Tracking**: Live Bitcoin price updates from CoinGecko API every 15 seconds
- **Interactive Charts**: Real-time line chart displaying Bitcoin price history
- **Admin Panel**: User management capabilities for administrators
- **Responsive UI**: Modern, gradient-based design with CSS styling

## Technology Stack

- **Backend**: Node.js, Express.js
- **Database**: MySQL
- **Real-time Communication**: Socket.IO
- **Templating**: EJS
- **Authentication**: bcrypt for password hashing, express-session for session management
- **HTTP Client**: Axios for API calls
- **Frontend**: Vanilla JavaScript, Chart.js for visualizations

## Project Structure

```
maximum/
├── app.js                 # Main application entry point
├── package.json           # Dependencies and scripts
├── config/
│   └── db.js             # MySQL database configuration
├── controllers/
│   ├── authController.js # Authentication logic
│   └── tradeController.js # Trading operations (incomplete)
├── middleware/
│   └── authMiddleware.js # Authentication middleware
├── models/
│   ├── user.js          # User model (empty)
│   └── trade.js         # Trade model (empty)
├── public/
│   ├── css/
│   │   └── style.css    # Application styles
│   └── js/
│       ├── chart.js     # Chart visualization logic
│       └── trading.js   # Trading interface (empty)
├── routes/
│   ├── admin.js         # Admin panel routes
│   ├── auth.js          # Authentication routes
│   ├── dashboard.js     # Dashboard routes
│   ├── public.js        # Public page routes
│   └── trade.js         # Trading routes (empty)
├── sockets/
│   ├── cryptoSocket.js  # Bitcoin price socket
│   └── priceSocket.js   # Alternative price socket
└── views/
    ├── auth/
    │   ├── login.ejs    # Login page
    │   └── register.ejs # Registration page
    ├── dashboard/
    │   ├── dashboard.ejs # User dashboard
    │   ├── index.ejs    # Alternative dashboard
    │   └── users.ejs    # Admin user list
    └── partials/
        ├── footer.ejs   # Footer partial
        └── navbar.ejs   # Navigation bar partial
```

## Installation and Setup

### Prerequisites

- Node.js (v14 or higher)
- MySQL Server
- npm or yarn

### Database Setup

1. Create a MySQL database named `crypto_platform`
2. Create a `users` table with the following structure:

```sql
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'user'
);
```

### Application Setup

1. Clone or download the project files
2. Navigate to the project directory
3. Install dependencies:

```bash
npm install
```

4. Update database configuration in `config/db.js` if needed (default: localhost, root, no password)
5. Start the application:

```bash
npm start
```

The application will run on `http://localhost:3000`

## API Endpoints

### Authentication
- `GET /login` - Login page
- `POST /login` - Process login
- `GET /register` - Registration page
- `POST /register` - Process registration
- `POST /logout` - Logout user

### Public Pages
- `GET /` - Homepage
- `GET /about` - About page
- `GET /faq` - FAQ page
- `GET /terms` - Terms page

### Dashboard
- `GET /dashboard` - User dashboard (requires authentication)

### Admin
- `GET /admin` - Admin panel (requires admin role)
- `GET /admin/delete/:id` - Delete user (requires admin role)

## Real-time Features

### Socket Events
- `btcPrice` - Emits current Bitcoin price in USD every 15 seconds

### Client-side Integration
The dashboard page connects to Socket.IO and updates the price display and chart in real-time.

## Security Features

- Password hashing using bcrypt
- Session-based authentication
- Admin role checking middleware
- Input validation (basic)

## Current Limitations

- Models are not implemented (empty files)
- Trade functionality is incomplete
- No input validation or sanitization
- No error handling in routes
- Duplicate authentication logic between routes and controllers
- No environment variable configuration
- Hard-coded API endpoints

## Development Notes

- The application uses EJS templating with partials for reusable components
- Real-time price updates are fetched from CoinGecko's free API
- Chart.js is used for rendering price history charts
- The application is designed to be extended with additional cryptocurrencies and trading features

## Contributing

To extend the application:

1. Implement the User and Trade models
2. Complete the trade controller and routes
3. Add proper error handling and validation
4. Implement environment variables for configuration
5. Add more cryptocurrencies to the price tracking
6. Enhance the admin panel with more features

## License

ISC License</content>
<parameter name="filePath">c:\Users\Gideonjosey\OneDrive\Desktop\PROJECT WITH NODE\MAXIMUM\README.md