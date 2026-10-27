const express = require('express');
const pool = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// BRIDGE TO PARSE JSON 
app.use(express.json());

// Serve static frontend files from the 'public' folder
app.use(express.static('public'));

// ==========================================
// STEP 6: Security Middleware for Stockroom
// ==========================================
const verifyStockroomPassword = (req, res, next) => {
    const providedPassword = req.headers['stockroom-password'];

    // Check if password header was provided and matches .env
    if (!providedPassword || providedPassword !== process.env.STOCKROOM_SECRET) {
        return res.status(403).json({ 
            error: "Access Denied. Unauthorized stockroom personnel or incorrect password." 
        });
    }

    // If password is correct, proceed to the endpoint
    next();
};

// ==========================================
// STEP 2: Add Equipment (Protected by Security Middleware)
// ==========================================
app.post('/api/equipment', verifyStockroomPassword, async (req, res) => {
    try { 
        const { equipment_name, total_quantity } = req.body;

        if (!equipment_name || total_quantity === undefined) {
            return res.status(400).json({ error: "Equipment Name and Total Quantity is Required" });
        }

        const query = `
            INSERT INTO equipment (equipment_name, total_quantity, available_quantity)
            VALUES ($1, $2, $2)
            RETURNING *;
        `;
      
        const value = [equipment_name, total_quantity];
        const new_equipment = await pool.query(query, value);
        
        res.status(201).json({
            message: 'Equipment Added Successfully',
            equipment: new_equipment.rows[0]
        });
    } catch (err) {
        console.log(err.message);
        res.status(500).json({ error: "Server Error While Adding Equipments" });
    }
});

// ==========================================
// STEP 3: Get All Equipment (Dashboard View)
// ==========================================
app.get('/api/equipment', async (req, res) => {
    try { 
        const query = 'SELECT * FROM equipment ORDER BY equipment_id ASC;';
        const allEquipment = await pool.query(query);

        res.status(200).json({
            count: allEquipment.rows.length,
            equipment: allEquipment.rows
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error while fetching Equipments" });
    }
});

// ==========================================
// STEP 4: Release and Record Transaction (Borrow)
// ==========================================
app.post('/api/transaction/borrow', async (req, res) => {
    try {
        const { equipment_id, worker_name, project_name, quantity_borrowed } = req.body;
        
        // Validation 
        if (!equipment_id || !worker_name || !project_name || !quantity_borrowed) {
            return res.status(400).json({ error: "All fields Are required" });
        }

        // Check if the equipment exists and available quantity
        const checkQuery = 'SELECT * FROM equipment WHERE equipment_id = $1';
        const equipmentResult = await pool.query(checkQuery, [equipment_id]);

        if (equipmentResult.rows.length === 0) {
            return res.status(404).json({ error: "Equipment Not found" });
        }
         
        const currentEquipment = equipmentResult.rows[0];
       
        // Check if there's enough stock available 
        if (currentEquipment.available_quantity < quantity_borrowed) {
            return res.status(400).json({
                error: "Not Enough Stock Available",
                available_quantity: currentEquipment.available_quantity
            });
        }

        // Insert into Transaction table 
        const insertTransactionQuery = `
            INSERT INTO transaction(equipment_id, worker_name, project_name, quantity_borrowed, status)
            VALUES ($1, $2, $3, $4, 'BORROWED')
            RETURNING *;
        `;
        const transactionValues = [equipment_id, worker_name, project_name, quantity_borrowed];
        const newTransaction = await pool.query(insertTransactionQuery, transactionValues);

        // Update equipment available quantity
        const updateQuery = `
            UPDATE equipment
            SET available_quantity = available_quantity - $1
            WHERE equipment_id = $2
            RETURNING *;    
        `;
        const updateValues = [quantity_borrowed, equipment_id];
        const updatedEquipment = await pool.query(updateQuery, updateValues);

        res.status(201).json({
            message: "Equipment Borrowed Successfully",
            transaction: newTransaction.rows[0],
            updated_inventory: updatedEquipment.rows[0]
        });
        
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error while processing borrow transaction" });
    }
});

// ==========================================
// STEP 5: Surrender and Return Equipments
// ==========================================
app.put('/api/transaction/return/:transaction_id', async (req, res) => {
    try {
        const { transaction_id } = req.params;

        const txQuery = 'SELECT * FROM transaction WHERE transaction_id = $1;';
        const txResult = await pool.query(txQuery, [transaction_id]);

        if (txResult.rows.length === 0) {
            return res.status(404).json({ error: "Transaction Not Found" });
        }

        const transaction = txResult.rows[0];

        if (transaction.status === 'RETURNED') {
            return res.status(400).json({ error: "This Equipment is Already Returned" });
        }

        // Update the transaction status to RETURNED
        const updateTxQuery = `
            UPDATE transaction
            SET status = 'RETURNED'
            WHERE transaction_id = $1
            RETURNING *;
        `;
        const updatedTx = await pool.query(updateTxQuery, [transaction_id]);

        // Add quantity back to available_quantity in equipment table
        const updateEqQuery = `
            UPDATE equipment
            SET available_quantity = available_quantity + $1
            WHERE equipment_id = $2
            RETURNING *;
        `;
        const updatedEquipments = await pool.query(updateEqQuery, [
            transaction.quantity_borrowed, 
            transaction.equipment_id
        ]);

        res.status(200).json({
            message: "Equipment Successfully Surrendered/Returned",
            transaction: updatedTx.rows[0],
            updated_inventory: updatedEquipments.rows[0]
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server Error While return Transaction" });
    }
});

// ==========================================
// STEP 5 (Bonus): Get All Active Borrowings (Tools on-site)
// ==========================================
app.get('/api/transaction/active', async (req, res) => {
    try {
        const query = `
            SELECT 
                t.transaction_id, 
                e.equipment_name, 
                t.worker_name, 
                t.project_name, 
                t.quantity_borrowed, 
                t.borrow_date, 
                t.status
            FROM transaction t
            JOIN equipment e ON t.equipment_id = e.equipment_id
            WHERE t.status = 'BORROWED'
            ORDER BY t.borrow_date DESC;
        `;
        const activeTools = await pool.query(query);

        res.status(200).json({
            count: activeTools.rows.length,
            active_borrowings: activeTools.rows
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error while fetching active borrowings" });
    }
});

// ==========================================
// NEW FEATURE: Full Transaction History (Audit Log)
// ==========================================
app.get('/api/transaction/history', async (req, res) => {
    try {
        const query = `
            SELECT 
                t.transaction_id, 
                e.equipment_name, 
                t.worker_name, 
                t.project_name, 
                t.quantity_borrowed, 
                t.borrow_date, 
                t.status
            FROM transaction t
            JOIN equipment e ON t.equipment_id = e.equipment_id
            ORDER BY t.borrow_date DESC;
        `;
        const historyResult = await pool.query(query);

        res.status(200).json({
            count: historyResult.rows.length,
            history: historyResult.rows
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error while fetching transaction history" });
    }
});

app.listen(PORT, () => {
    console.log(`ELS Server running on port ${PORT}`);
});