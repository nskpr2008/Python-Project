-- Structure only: roles and the 14 departments. No products, prices, stock or ratings are invented here.
INSERT INTO roles (name) VALUES ('customer'),('staff'),('admin');
INSERT INTO permissions (code) VALUES ('products.write'),('orders.manage'),('refunds.approve'),('customers.read'),('security.view'),('reports.view'),('staff.manage');
INSERT INTO role_permissions SELECT r.id,p.id FROM roles r,permissions p WHERE r.name='admin';
INSERT INTO role_permissions SELECT r.id,p.id FROM roles r,permissions p WHERE r.name='staff' AND p.code IN ('products.write','orders.manage');
INSERT INTO categories (name, slug, sort) VALUES
 ('Smartphones','smartphones',1),('Laptops and Computers','laptops-computers',2),('Monitors and Displays','monitors-displays',3),('Gaming','gaming',4),
 ('Tablets and E-readers','tablets-ereaders',5),('TVs and Home Entertainment','tvs-entertainment',6),('Cameras and Photography','cameras',7),('Audio and Headphones','audio',8),
 ('Wearables','wearables',9),('PC Components and Storage','pc-components',10),('Smart Home and Security','smart-home',11),('Accessories and Connectivity','accessories',12),
 ('Home Appliances','home-appliances',13),('Power and Networking','power-networking',14);
