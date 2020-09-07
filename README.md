Gas Ticker
==========

A very simple oracle to track gas prices.

How it works
------------

A WebSocketProvider is used to subscribe to the `"pending"` filter
and the `"block"` filter.

On each pending transaction hash, its *"time seen"* added to a database.

On each `"block"`, each transaction in that block has its delta time
computed from the time the transaction was seen to the time it was mined.

The last 100 blocks are then analysed and statistics ensue.

Any blocks or transactions not mined within 2 days are purged to constrain
the database size.

How to use it
-------------

```
/home/ricmoo/gas-ticker> npm start
```

The result will be dumped to `database/gas-price.json`.

The node scripts are executed inside a shell script which will
automatically restart the node process and the server is deisgned
to exit if it detects more than 10s of inactivity.


To Do
-----

- CLI option to adjusting the statistic properties (like block count)
- CLI options to change the database location


License
-------

The MIT License.
